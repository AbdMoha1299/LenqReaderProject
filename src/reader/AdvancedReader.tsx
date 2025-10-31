import { useMemo } from 'react';
import { ReaderProvider } from './contexts/ReaderContext';
import type { ReaderManifest } from './types';
import { ReaderShell } from './components/ReaderShell/ReaderShell';

interface ReaderAccessData {
  userId: string;
  userName?: string;
  userNumber?: string;
  editionId: string;
  editionTitle?: string;
  pdfId?: string;
}

interface AdvancedReaderProps {
  manifest: ReaderManifest;
  token: string;
  accessData: ReaderAccessData;
  sessionId: string;
  onExit: () => void;
}

export const AdvancedReader = ({
  manifest,
  token,
  accessData,
  sessionId,
  onExit,
}: AdvancedReaderProps) => {
  const access = useMemo(
    () => ({
      token,
      accessData: {
        ...accessData,
        sessionId,
      },
    }),
    [accessData, sessionId, token]
  );

  return (
    <ReaderProvider manifest={manifest} access={access}>
      <ReaderShell onExit={onExit} />
    </ReaderProvider>
  );
};

