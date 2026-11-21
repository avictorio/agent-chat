import { Button } from "../ui/Button";

// What the page shows when nothing narrower caught a render error: a way
// back instead of a blank page.
export function RootFallback() {
  return (
    <div className="err-page" role="alert">
      <h1>Something went wrong</h1>
      <p>This page hit an error it couldn't recover from. Reloading usually fixes it.</p>
      <Button type="button" variant="primary" onClick={() => location.reload()}>
        Reload
      </Button>
    </div>
  );
}
