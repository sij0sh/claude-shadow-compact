import { access } from "node:fs/promises";
export function workerCancellation(deadlineMs, cancelPath, parentSignal) {
    const cancelled = new AbortController();
    const signal = AbortSignal.any([
        AbortSignal.timeout(deadlineMs),
        cancelled.signal,
        ...parentSignal ? [
            parentSignal
        ] : []
    ]);
    const check = async ()=>{
        if (cancelPath && await access(cancelPath).then(()=>true, ()=>false)) cancelled.abort();
    };
    const timer = cancelPath ? setInterval(()=>{
        void check();
    }, 250) : undefined;
    timer?.unref();
    return {
        signal,
        check,
        close: ()=>{
            if (timer) clearInterval(timer);
        }
    };
}
