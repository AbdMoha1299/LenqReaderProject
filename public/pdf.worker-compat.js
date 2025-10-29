(() => {
  if (typeof Promise !== 'undefined' && typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function withResolvers() {
      let resolve;
      let reject;

      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });

      return { promise, resolve, reject };
    };
  }
})();

const workerUrl = '/pdfjs/pdf.worker.min.mjs';

if (typeof importScripts === 'function') {
  importScripts(workerUrl);
} else {
  // Safari module worker fallback
  (async () => {
    const response = await fetch(workerUrl);
    const scriptContent = await response.text();
    // eslint-disable-next-line no-new-func
    const execute = new Function(scriptContent);
    execute();
  })().catch((err) => {
    throw new Error(`Unable to load pdf.js worker: ${err instanceof Error ? err.message : String(err)}`);
  });
}
