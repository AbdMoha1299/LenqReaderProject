export function normalizePhoneNumber(phone: string): string {
  let cleaned = phone.trim().replace(/\s+/g, '').replace(/[^\d+]/g, '');
  if (!cleaned.startsWith('+')) cleaned = `+${cleaned.replace(/^\+/, '')}`;
  return cleaned;
}

export function formatPhoneNumber(phone: string): string {
  return normalizePhoneNumber(phone);
}

export function validatePhoneNumber(phone: string): boolean {
  const cleaned = phone.replace(/\D/g, '');
  const validPrefixes = ['229', '227', '225', '221', '228', '226', '223', '233', '234'];
  const hasValidPrefix = validPrefixes.some((prefix) => cleaned.startsWith(prefix));
  return hasValidPrefix && cleaned.length >= 10 && cleaned.length <= 15;
}

export function detectCountryCode(phone: string): string {
  const cleaned = phone.replace(/\D/g, '');
  if (cleaned.startsWith('229')) return 'BJ';
  if (cleaned.startsWith('227')) return 'NE';
  if (cleaned.startsWith('225')) return 'CI';
  if (cleaned.startsWith('221')) return 'SN';
  if (cleaned.startsWith('228')) return 'TG';
  if (cleaned.startsWith('226')) return 'BF';
  if (cleaned.startsWith('223')) return 'ML';
  if (cleaned.startsWith('233')) return 'GH';
  if (cleaned.startsWith('234')) return 'NG';
  return 'BJ';
}

export const COUNTRY_OPTIONS = [
  { code: 'BJ', name: 'Benin', prefix: '+229' },
  { code: 'NE', name: 'Niger', prefix: '+227' },
  { code: 'CI', name: "Cote d'Ivoire", prefix: '+225' },
  { code: 'SN', name: 'Senegal', prefix: '+221' },
  { code: 'TG', name: 'Togo', prefix: '+228' },
  { code: 'BF', name: 'Burkina Faso', prefix: '+226' },
  { code: 'ML', name: 'Mali', prefix: '+223' },
  { code: 'GH', name: 'Ghana', prefix: '+233' },
  { code: 'NG', name: 'Nigeria', prefix: '+234' },
];
