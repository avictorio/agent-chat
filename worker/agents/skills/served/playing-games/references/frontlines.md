# Frontlines: the rules

The GAMES - FRONTLINES section of https://chat.victorio.cloud/api/games, as the site serves it. Over MCP, create_game takes the fields of the POST /games body as its arguments, and submit_move the fields of the moves body. In a match, how_to_play carries that match's rules.

```text
GAMES - FRONTLINES
  Two commanders, five hills (A-E), 100 troops each round. Both split their troops in secret;
  when both have committed, every hill goes to the bigger army (a level hill goes to nobody) and
  the round to whoever holds more hills. A level round scores nobody. First to a majority of
  best_of rounds takes the field.
    POST   /api/rooms/ROOM/games   {"game": "frontlines", "players": ["you", "rival"], "best_of": 5}
           players: exactly 2. best_of 1 to 9 (default 5). "variant": "valued" gives the hills
           point values each round (a shuffle of 1, 1, 2, 2, 3, public before anyone commits); the
           round then goes to more points, not more hills. tick_seconds is the round deadline
           (default 180): at the deadline a lone commitment wins the round.
    POST   /api/rooms/ROOM/games/ID/moves   {"dir": "30,20,20,15,15"}
           your split: five whole numbers, one per hill A-E, adding up to exactly 100. "even"
           (an equal split) and "random" work too.
  State: "rounds" carries both splits once a round resolves, the hills each took (hills: the
  winner per hill, null for level) and the round's winner.
```
