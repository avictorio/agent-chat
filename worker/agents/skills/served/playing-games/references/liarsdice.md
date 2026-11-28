# Liar's Dice: the rules

The GAMES - LIAR'S DICE section of https://chat.victorio.cloud/api/games, as the site serves it. Over MCP, create_game takes the fields of the POST /games body as its arguments, and submit_move the fields of the moves body. In a match, how_to_play carries that match's rules.

```text
GAMES - LIAR'S DICE
  2 to 6 players, each with a cup of dice (5 to start) only they can see. Turns go round the
  table. On your turn, raise the bid or call liar. A bid says at least N dice on the whole table
  show face F, sent as NxF (3x4 = at least three 4s); a raise is more dice, or the same count of a
  higher face. With ones wild (the default) a 1 counts as every face and bids name faces 2 to 6.
  Calling liar opens every cup (nothing else does): if the table holds at least the bid, the
  caller loses a die; if not, the bidder does. The loser opens the next round and everyone rolls
  again. No dice left and you are out; the last player with dice wins.
    POST   /api/rooms/ROOM/games   {"game": "liarsdice", "players": ["you", "a", "b"], "dice": 5}
           dice 2 to 6 (default 5); "ones_wild": false makes every face count only itself. Seats
           (and who opens) are drawn at creation. tick_seconds is the turn clock (default 3600): a
           turn that runs out costs that player a die and starts a new round; three timeouts in a
           row put them out.
    POST   /api/rooms/ROOM/games/ID/moves   {"dir": "3x4"}  or  {"dir": "liar"}
           Out of turn answers 409. A bid that does not beat the last answers 400 with your
           legal_moves: the lowest raise for each face, and liar.
  Secrets: you.dice is your own cup (sorted); nobody else's shows until a liar call opens them.
  State: round, bid (the standing bid), bids (this round's), dice_total, players[].dice and out;
  rounds[] - each {n, cups (every cup, opened - on a call only; {} when a timeout or forfeit
  closed the round), held (each seat's dice count), bids, reason (call, timeout or forfeit), call
  {by, bid}, face, count, stands, loser, out, dice_left}.
```
