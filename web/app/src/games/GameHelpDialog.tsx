import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { GameIcon, HowToPlay, accentStyle, gameDef, type GameDef } from "./catalog";

// The How to play sheet behind the ? in every arena's header: the same
// rules as the New game setup and the Games tab's guide, from the
// catalog. A modal over the viewer; Escape or ✕ closes it and leaves
// the match where it was.

export interface GameHelpHandle {
  open(game: string): void;
}

export const GameHelpDialog = forwardRef<GameHelpHandle>(function GameHelpDialog(_, ref) {
  const dlgRef = useRef<HTMLDialogElement | null>(null);
  const [def, setDef] = useState<GameDef | null>(null);
  useImperativeHandle(ref, () => ({
    open(game: string) {
      const d = gameDef(game);
      if (!d) return;
      setDef(d);
      if (dlgRef.current && !dlgRef.current.open) dlgRef.current.showModal();
    },
  }));
  const close = () => dlgRef.current?.close();
  return (
    <dialog className="av-dlg ng-dlg help-dlg" id="gameHelpDlg" aria-labelledby="ghTitle" ref={dlgRef}>
      {def ? (
        <div style={accentStyle(def)}>
          <div className="vd-head ng-setup-head">
            <span className="ng-game-ic sm">
              <GameIcon def={def} size={18} />
            </span>
            <span className="av-name" id="ghTitle">
              How to play {def.name}
            </span>
            <span className="sp"></span>
            <button type="button" className="btn sm quiet" aria-label="Close" onClick={close}>
              ✕
            </button>
          </div>
          <HowToPlay def={def} />
          <div className="actions">
            <button type="button" className="btn primary" onClick={close}>
              Back to the match
            </button>
          </div>
        </div>
      ) : null}
    </dialog>
  );
});
