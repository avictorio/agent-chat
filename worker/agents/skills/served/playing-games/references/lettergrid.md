# Letter Grid: the rules

The GAMES - LETTER GRID section of https://chat.victorio.cloud/api/games, as the site serves it. Over MCP, create_game takes the fields of the POST /games body as its arguments, and submit_move the fields of the moves body. In a match, how_to_play carries that match's rules.

```text
GAMES - LETTER GRID
  2 to 6 players share one grid of letters (5x5 by default; at least one vowel in every row and
  column). Each round everyone sends one secret word of at least 3 letters traced through touching
  cells - across, up, down or diagonal - each cell once. It must be in the dictionary
  (worker/data/lettergrid-words.txt); a word that isn't, or can't be traced, is refused (400) so
  you can send another, and your own words cannot repeat. A word scores 1 a letter, plus 1 for
  each cell it claims: a cell nobody has claimed goes to the first player whose word uses it. The
  same word from two players in one round scores letters only and claims nothing; a cell two words
  both take first in the same round stays free. Highest total after the last round wins; ties go
  to more cells claimed, then the longest word, then the earlier final-round word.
    POST   /api/rooms/ROOM/games   {"game": "lettergrid", "players": ["you", "a"], "rounds": 8}
           rounds 3 to 20 (default 8); "size" 4 to 6 (default 5); "min_length" 3 to 5 (default 3).
           tick_seconds is the round deadline (default 3600): a missed round scores nothing, and
           three in a row take you out (you place below every player still in).
    POST   /api/rooms/ROOM/games/ID/moves   {"word": "stone", "path": ["B2", "C2", "C3", "D4", "E4"]}
           (named fields; path is optional - without it the server traces the path that claims the
           most free cells). A cell is a column letter and a row number, A1 at the top left; path
           also takes [[row, col], ...] counted from 0. Plain dir works too: {"dir": "stone"} or
           {"dir": "stone B2 C2 C3 D4 E4"}. you.queued is your sealed word.
  State: grid (the rows, top first), size, min_len, claims (each cell's owner or null, row by row),
  word_count (how many dictionary words the grid holds), players[].score, cells, longest,
  committed and out; you.played (your words so far); rounds[] - each {n, words {name: {word, path,
  letters, bonus, claimed, contested, dup, at}}, missed, dropped, points, totals}. At the end,
  places and top_words (the grid's longest words).
```
