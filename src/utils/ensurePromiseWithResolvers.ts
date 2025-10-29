type PromiseConstructorWithResolvers = PromiseConstructor & {
 withResolvers?<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
 };
};

export const ensurePromiseWithResolvers = () => {
 const promiseCtor = Promise as PromiseConstructorWithResolvers;
 if (typeof promiseCtor.withResolvers === 'function') {
  return;
 }

 promiseCtor.withResolvers = <T = unknown>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
   resolve = res;
   reject = rej;
  });

  return { promise, resolve, reject };
 };
};

