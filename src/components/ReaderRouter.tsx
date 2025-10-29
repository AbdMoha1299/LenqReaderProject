import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { ModernPDFReader } from './ModernPDFReader';
import { MagazineReader } from './MagazineReader';

interface ReaderRouterProps {
  token: string;
}

interface ValidationResult {
  valid: boolean;
  hasArticles: boolean;
  editionId?: string;
  editionTitle?: string;
  pdfUrl?: string;
  pdfTitle?: string;
  userId: string;
  userName: string;
  userNumber?: string;
  error?: string;
}

export function ReaderRouter({ token }: ReaderRouterProps) {
  const [validating, setValidating] = useState(true);
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    validateToken();
  }, [token]);

  const validateToken = async () => {
    try {
      const deviceFingerprint = {
        userAgent: navigator.userAgent,
        screenResolution: `${screen.width}x${screen.height}`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        language: navigator.language,
      };

      let ipAddress = '';
      try {
        const ipResponse = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipResponse.json();
        ipAddress = ipData.ip;
      } catch (e) {
        console.log('Could not fetch IP');
      }

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/validate-edition-access`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            token,
            deviceFingerprint,
            ipAddress
          }),
        }
      );

      const data = await response.json();

      if (!response.ok || data.error) {
        const reason = typeof data.reason === 'string' ? data.reason : '';
        const baseError = data.error || 'Token invalide';
        setError(reason ? `${baseError} : ${reason}` : baseError);
        return;
      }

      setValidationResult(data);
    } catch (err) {
      console.error('Error validating token:', err);
      setError('Erreur lors de la validation du token');
    } finally {
      setValidating(false);
    }
  };

  if (validating) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-12 h-12 animate-spin text-amber-500 mx-auto mb-4" />
          <p className="text-gray-400">Validation de votre accès...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
        <div className="bg-gray-800 border border-red-700 rounded-lg p-8 max-w-md text-center">
          <div className="w-16 h-16 bg-red-900/50 rounded-full flex items-center justify-center mx-auto mb-4">
            <span className="text-3xl">⚠️</span>
          </div>
          <h2 className="text-xl font-bold text-white mb-2">Accès refusé</h2>
          <p className="text-gray-400 mb-4">{error}</p>
          <p className="text-sm text-gray-500">
            Si vous pensez qu'il s'agit d'une erreur, veuillez contacter le support.
          </p>
        </div>
      </div>
    );
  }

  if (!validationResult) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <p className="text-gray-400">Erreur inconnue</p>
      </div>
    );
  }

  if (validationResult.hasArticles && validationResult.editionId) {
    return (
      <MagazineReader
        editionId={validationResult.editionId}
        userId={validationResult.userId}
      />
    );
  }

  return (
    <ModernPDFReader
      token={token}
      initialData={{
        pdfUrl: validationResult.pdfUrl ?? '',
        pdfTitle: validationResult.pdfTitle,
        userId: validationResult.userId,
        userName: validationResult.userName,
        userNumber: validationResult.userNumber,
        editionId: validationResult.editionId ?? null,
        editionTitle: validationResult.editionTitle,
        hasArticles: validationResult.hasArticles,
      }}
    />
  );
}
