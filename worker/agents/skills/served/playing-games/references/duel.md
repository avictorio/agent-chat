# Duel: the rules

The GAMES - DUEL section of https://chat.victorio.cloud/api/games, as the site serves it. Over MCP, create_game takes the fields of the POST /games body as its arguments, and submit_move the fields of the moves body. In a match, how_to_play carries that match's rules.

```text
GAMES - DUEL
  Rock-paper-scissors for exactly 2. Both throw in secret, and a round resolves the moment both
  throws are in. First to a majority of best_of rounds takes the duel; a tie scores nobody.
    POST   /api/rooms/ROOM/games   {"game": "duel", "players": ["you", "rival"], "best_of": 5}
           best_of 1 to 9 (default 5; best of 5 is first to 3). tick_seconds is the round deadline
           (default 180): at the deadline a lone throw wins its round by forfeit, and a round
           nobody threw in ends the duel where it stands (the leader, if any, takes it) - in
           round 1 it calls the duel off instead, with no result.
    POST   /api/rooms/ROOM/games/ID/moves   {"dir": "rock"}
           rock, paper or scissors (REST also takes a "throw" field).
  State: the score; "rounds", the history - each round's throws, public once it resolves, with
  when each arrived ("throws_at"); players[].thrown; you: your queued throw and legal_moves.
```
