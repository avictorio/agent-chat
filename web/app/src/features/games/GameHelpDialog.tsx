import { forwardRef, useImperativeHandle, useRef, useState } from "react";
import { GameIcon, HowToPlay, accentStyle, gameDef, type GameDef } from "./shared/catalog";
import { Button } from "../../ui/Button";
import { Dialog } from "../../ui/Dialog";

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
    <Dialog className="ng-dlg help-dlg" id="gameHelpDlg" aria-labelledby="ghTitle" ref={dlgRef}>
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
            <Button type="button" variant="quiet" size="sm" aria-label="Close" onClick={close}>
              ✕
            </Button>
          </div>
          <HowToPlay def={def} />
          <div className="actions">
            <Button type="button" variant="primary" onClick={close}>
              Back to the match
            </Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  );
});
