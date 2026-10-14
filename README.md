# needs-you

A Claude Code mod based on Convex's video ["I fixed Claude to MASSIVELY boost my productivity"](https://www.youtube.com/watch?v=fXETGbqwrng): Claude ends every turn with a numbered **What I need from you** list, or "Nothing needed from you right now".

- The rule rides the system prompt (not CLAUDE.md); left out for teammates and `-p` runs.
- Each item is typed: `[do]` (off-system / clickops) or `[ask]` (a decision or questions, with 2-4 options).
- A band above the prompt lists the open items. Press its digit with an empty prompt (or with the band focused):
  - `do` is marked done;
  - `ask` opens Claude Code's own question dialog, one question at a time.
- Answers are held, then sent to Claude as one message once the last open item is answered. A message you send first carries the answers held so far.
- A turn with no list keeps the open items and notes it on the status line; "Nothing needed" clears them.

## Install

At the prompt of a terminal session:

```
/plugin install needs-you --marketplace MasonRhodesDev/needs-you
```

From a shell:

```
claude plugin install needs-you --marketplace MasonRhodesDev/needs-you
```

The repository is private: installing needs read access and a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Develop

```
claude plugin validate .
claude plugin test .
```
