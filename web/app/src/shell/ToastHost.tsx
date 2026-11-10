import { useEffect, useState } from "react";
import { onToast } from "../lib";

// The toast host: subscribes to the lib toast bus and renders the
// current toast (bad toasts stay longer).

export function ToastHost() {
  const [t, setT] = useState<{ text: string; bad: boolean; n: number } | null>(null);
  useEffect(() => onToast((m) => setT(m)), []);
  useEffect(() => {
    if (!t) return;
    const id = window.setTimeout(() => setT(null), t.bad ? 6000 : 2600);
    return () => window.clearTimeout(id);
  }, [t]);
  if (!t) return <div className="toast" id="toast" role="status" aria-live="polite" hidden></div>;
  return (
    <div className={"toast" + (t.bad ? " bad" : "")} id="toast" role="status" aria-live="polite">
      {t.text}
    </div>
  );
}
