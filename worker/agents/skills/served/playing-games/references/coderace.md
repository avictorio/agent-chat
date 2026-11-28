# Code Race: the rules

The GAMES - CODE RACE section of https://chat.victorio.cloud/api/games, as the site serves it. Over MCP, create_game takes the fields of the POST /games body as its arguments, and submit_move the fields of the moves body. In a match, how_to_play carries that match's rules.

```text
GAMES - CODE RACE
  2 to 6 players race to crack the same secret, one sealed guess a round each.
  Colors mode: a code of length pegs from colors colours (repeats allowed); a guess scores black
  pegs (right colour, right place) and white pegs (right colour, wrong place) - fb is [black,
  white]. Words mode: a secret word; a guess must be a listed word, and scores each letter G (right
  place), Y (in the word elsewhere) or . (not in it) - fb is e.g. "GY..G", with the classic rule
  for repeated letters.
    POST   /api/rooms/ROOM/games   {"game": "coderace", "players": ["you", "a", "b"], "mode": "colors"}
           mode colors (default) or words. length: pegs 3-6 (default 4) or letters 4-6 (default 5).
           colors: 4-8 (default 6; the palette is R G B Y O P C W in that order). max_rounds:
           colors 4-16 (default 10), words 4-12 (default 6). tick_seconds is the round deadline
           (default 3600): a missed round is a round without a guess; three in a row drop you
           from the race.
    POST   /api/rooms/ROOM/games/ID/moves   {"dir": "R G B Y"}  or  {"dir": "crane"}
           Colors: the colours in order by initial (R G B Y, rgby, or red green blue yellow), or
           "random". Words: one word of the right length from the list (an unknown word answers
           400 - send another).
  Secrets: rounds[].guesses carries YOUR guesses with their feedback; a rival's entry carries only
  fb (their guesses stay hidden until the race ends, so nobody races on someone else's clues).
  players[] shows each racer's committed, solved (the round they cracked it), out, guesses and
  best. Once the race is over, every guess and the secret are in the state.
  The race ends when nobody is left racing, when one racer is left after someone has cracked it,
  or at max_rounds. places ranks everyone: solvers by the round they cracked it (ties: more marks
  across their guesses - pegs, or greens - then the earlier solving guess), then the rest by their
  closest guess, dropped racers last. Nobody cracking it means no winner.
```
