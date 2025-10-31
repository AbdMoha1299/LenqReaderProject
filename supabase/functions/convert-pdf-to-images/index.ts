import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Edge Function pour convertir un PDF en images multi-résolutions
 *
 * Cette fonction:
 * 1. Télécharge le PDF depuis Supabase Storage
 * 2. Utilise pdf-to-png (ou poppler via subprocess) pour générer des PNGs
 * 3. Convertit les PNGs en WebP avec plusieurs résolutions (thumb, low, medium, high)
 * 4. Upload les images vers Supabase Storage
 * 5. Génère et sauvegarde le manifest.json
 *
 * NOTE: Deno ne supporte pas nativement la conversion PDF→Image
 * Options possibles:
 * - Utiliser un service externe (PDF.co, Cloudinary, etc.)
 * - Appeler un endpoint Node.js/Python dédié avec Sharp + Poppler
 * - Utiliser un worker avec wasm (pdf.js)
 */

interface ConversionRequest {
  editionId: string;
  pdfUrl: string;
  totalPages?: number | null;
}

serve(async (req) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    const { editionId, pdfUrl, totalPages }: ConversionRequest = await req.json();

    if (!editionId || !pdfUrl) {
      return new Response(
        JSON.stringify({ error: 'Missing editionId or pdfUrl' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    console.log(`Starting conversion for edition ${editionId}`);

    // OPTION 1: Utiliser un service externe (PDF.co API)
    // const pdfCoApiKey = Deno.env.get('PDFCO_API_KEY');
    // if (pdfCoApiKey) {
    //   return await convertWithPdfCo(editionId, pdfUrl, totalPages, supabase);
    // }

    // OPTION 2: Appeler un service Node.js/Python dédié
    const conversionServiceUrl = Deno.env.get('PDF_CONVERSION_SERVICE_URL');
    const conversionServiceSecret = Deno.env.get('PDF_CONVERSION_SERVICE_SECRET') ?? '';
    if (conversionServiceUrl) {
      const response = await fetch(`${conversionServiceUrl.replace(/\/$/, '')}/convert`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(conversionServiceSecret ? { 'X-Api-Key': conversionServiceSecret } : {}),
        },
        body: JSON.stringify({
          editionId,
          pdfUrl,
          totalPages,
          supabaseUrl,
          supabaseKey,
        }),
      });

      if (!response.ok) {
        throw new Error(`Conversion service failed: ${await response.text()}`);
      }

      const result = await response.json() as {
        success: boolean;
        pages?: Array<{
          pageNumber: number;
          width: number | null;
          height: number | null;
          assets: Record<string, { path: string; publicUrl: string }>;
        }>;
        bucket?: string;
        manifestPath?: string;
        uploads?: string[];
        totalPages?: number;
        error?: string;
      };

      if (!result.success) {
        throw new Error(result.error ?? 'Conversion service returned an error');
      }

      if (Array.isArray(result.pages) && result.pages.length > 0) {
        const updates = result.pages.map((page) => {
          const lowAsset = page.assets?.low ?? page.assets?.medium ?? page.assets?.high;
          const thumbAsset = page.assets?.thumbnail ?? page.assets?.low ?? page.assets?.medium;

          return {
            edition_id: editionId,
            page_number: page.pageNumber,
            image_url: lowAsset?.path ?? null,
            thumbnail_url: thumbAsset?.path ?? null,
            width: page.width,
            height: page.height,
            updated_at: new Date().toISOString(),
          };
        });

        if (updates.length > 0) {
          const { error: upsertError } = await supabase
            .from('pages')
            .upsert(updates, { onConflict: 'edition_id,page_number' });

          if (upsertError) {
            console.error('Failed to upsert pages metadata', upsertError);
          }
        }
      }

      if (typeof result.totalPages === 'number' && result.totalPages > 0) {
        const { error: editionUpdateError } = await supabase
          .from('editions')
          .update({ nb_pages: result.totalPages })
          .eq('id', editionId);

        if (editionUpdateError) {
          console.error('Failed to update edition page count', editionUpdateError);
        }
      }

      return new Response(JSON.stringify({
        success: true,
        editionId,
        totalPages: result.totalPages ?? totalPages ?? null,
        manifestPath: result.manifestPath ?? null,
        bucket: result.bucket ?? 'editions',
        uploads: result.uploads ?? [],
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // OPTION 3 (Fallback): Générer un manifest basique sans conversion
    // En production, il faut implémenter l'une des options ci-dessus
    console.warn('No conversion service configured, generating basic manifest');

    const manifest = {
      editionId,
      title: `Édition ${editionId}`,
      date: new Date().toISOString(),
      totalPages,
      format: {
        width: 2400,
        height: 3600,
        ratio: 0.6667,
      },
      pages: Array.from({ length: totalPages }, (_, i) => ({
        number: i + 1,
        thumb: `/editions/${editionId}/pages/thumb/page-${String(i + 1).padStart(3, '0')}.webp`,
        sizes: {
          low: {
            url: `/editions/${editionId}/pages/low/page-${String(i + 1).padStart(3, '0')}.webp`,
            width: 800,
            height: 1200,
            sizeBytes: 120000,
          },
          medium: {
            url: `/editions/${editionId}/pages/medium/page-${String(i + 1).padStart(3, '0')}.webp`,
            width: 1200,
            height: 1800,
            sizeBytes: 350000,
          },
          high: {
            url: `/editions/${editionId}/pages/high/page-${String(i + 1).padStart(3, '0')}.webp`,
            width: 2400,
            height: 3600,
            sizeBytes: 800000,
          },
        },
        articleIds: [],
      })),
      articles: [],
    };

    // Sauvegarder le manifest
    const manifestJson = JSON.stringify(manifest, null, 2);
    const { error: uploadError } = await supabase.storage
      .from('editions')
      .upload(`${editionId}/manifest.json`, manifestJson, {
        contentType: 'application/json',
        upsert: true,
      });

    if (uploadError) {
      throw new Error(`Failed to upload manifest: ${uploadError.message}`);
    }

    const result: ConversionResult = {
      success: true,
      editionId,
      manifestUrl: `/cdn/editions/${editionId}/manifest.json`,
    };

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Conversion error:', error);
    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
});
