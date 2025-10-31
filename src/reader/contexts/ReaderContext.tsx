import { createContext, useContext, useMemo, useReducer, type ReactNode } from 'react';
import type {
  ReaderAction,
  ReaderManifest,
  ReaderState,
  ReaderAccessContext,
} from '../types';

const initialState: ReaderState = {
  status: 'loading',
  currentPage: 1,
  totalPages: 0,
  zoom: 1,
  mode: 'page',
  activeArticleId: null,
};

const ReaderStateContext = createContext<ReaderState | null>(null);
const ReaderDispatchContext = createContext<React.Dispatch<ReaderAction> | null>(null);
const ReaderManifestContext = createContext<ReaderManifest | null>(null);
const ReaderAccessContextInternal = createContext<ReaderAccessContext | null>(null);

const reducer = (state: ReaderState, action: ReaderAction): ReaderState => {
  switch (action.type) {
    case 'SET_READY':
      return {
        ...state,
        status: 'ready',
        totalPages: action.payload.totalPages,
        currentPage: Math.min(state.currentPage, Math.max(1, action.payload.totalPages)),
        error: undefined,
      };
    case 'SET_PAGE':
      return {
        ...state,
        currentPage: Math.max(1, Math.min(action.payload, state.totalPages || 1)),
      };
    case 'SET_MODE':
      return {
        ...state,
        mode: action.payload,
      };
    case 'SET_ACTIVE_ARTICLE':
      return {
        ...state,
        activeArticleId: action.payload,
      };
    case 'SET_ZOOM':
      return {
        ...state,
        zoom: Math.max(0.5, Math.min(action.payload, 3)),
      };
    case 'SET_ERROR':
      return {
        ...state,
        status: 'error',
        error: action.payload,
      };
    case 'RESET':
      return { ...initialState };
    default:
      return state;
  }
};

interface ReaderProviderProps {
  manifest: ReaderManifest;
  access: ReaderAccessContext;
  children: ReactNode;
}

export const ReaderProvider = ({ manifest, access, children }: ReaderProviderProps) => {
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    status: 'ready',
    totalPages: manifest.pages.length,
  });

  const accessValue = useMemo(() => access, [access]);

  return (
    <ReaderAccessContextInternal.Provider value={accessValue}>
      <ReaderManifestContext.Provider value={manifest}>
        <ReaderStateContext.Provider value={state}>
          <ReaderDispatchContext.Provider value={dispatch}>
            {children}
          </ReaderDispatchContext.Provider>
        </ReaderStateContext.Provider>
      </ReaderManifestContext.Provider>
    </ReaderAccessContextInternal.Provider>
  );
};

export const useReaderState = () => {
  const context = useContext(ReaderStateContext);
  if (!context) {
    throw new Error('useReaderState must be used within a ReaderProvider');
  }
  return context;
};

export const useReaderDispatch = () => {
  const context = useContext(ReaderDispatchContext);
  if (!context) {
    throw new Error('useReaderDispatch must be used within a ReaderProvider');
  }
  return context;
};

export const useReaderManifest = () => {
  const context = useContext(ReaderManifestContext);
  if (!context) {
    throw new Error('useReaderManifest must be used within a ReaderProvider');
  }
  return context;
};

export const useReaderAccess = () => {
  const context = useContext(ReaderAccessContextInternal);
  if (!context) {
    throw new Error('useReaderAccess must be used within a ReaderProvider');
  }
  return context;
};

