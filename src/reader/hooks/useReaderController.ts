import { useCallback } from 'react';
import { useReaderDispatch, useReaderState } from '../contexts/ReaderContext';

export const useReaderController = () => {
  const state = useReaderState();
  const dispatch = useReaderDispatch();

  const goToPage = useCallback(
    (page: number) => {
      dispatch({ type: 'SET_PAGE', payload: page });
    },
    [dispatch]
  );

  const goToNextPage = useCallback(() => {
    if (state.currentPage >= state.totalPages) return;
    dispatch({ type: 'SET_PAGE', payload: state.currentPage + 1 });
  }, [dispatch, state.currentPage, state.totalPages]);

  const goToPreviousPage = useCallback(() => {
    if (state.currentPage <= 1) return;
    dispatch({ type: 'SET_PAGE', payload: state.currentPage - 1 });
  }, [dispatch, state.currentPage]);

  const enterArticleMode = useCallback(
    (articleId: string) => {
      dispatch({ type: 'SET_ACTIVE_ARTICLE', payload: articleId });
      dispatch({ type: 'SET_MODE', payload: 'article' });
    },
    [dispatch]
  );

  const exitArticleMode = useCallback(() => {
    dispatch({ type: 'SET_MODE', payload: 'page' });
    dispatch({ type: 'SET_ACTIVE_ARTICLE', payload: null });
  }, [dispatch]);

  const setZoom = useCallback(
    (zoom: number) => {
      dispatch({ type: 'SET_ZOOM', payload: zoom });
    },
    [dispatch]
  );

  return {
    state,
    goToPage,
    goToNextPage,
    goToPreviousPage,
    enterArticleMode,
    exitArticleMode,
    setZoom,
  };
};

