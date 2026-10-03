# opencode-clm

```
  ____ _     __  __
 / ___| |   |  \/  |
| |   | |   | |\/| |
| |___| |___| |  | |
 \____|_____|_|  |_|     opencode-clm — the agent that manages its own context
```

`opencode-clm` is an [OpenCode](https://opencode.ai) plugin that lets the agent manage its
own context: before each request the plugin writes the conversation to a file, the
language model edits that file with its ordinary tools, and the edited version becomes its
next input. OpenCode's stored session stays unchanged. It ports
[pi-clm](https://github.com/lolipopshock/pi-clm), the Pi extension for the paper
[Context Language Models](https://arxiv.org/pdf/2609.37725) and its [research
codebase](https://github.com/facebookresearch/context-language-models).

## Install

```sh
opencode plugin opencode-clm        # this project: .opencode/opencode.json and .opencode/tui.json
opencode plugin -g opencode-clm     # global: opencode.json(c) and tui.json in ~/.config/opencode
```

The package holds two plugins: the server plugin (`index.ts`: mirror, edits, budget,
`/clm`, `/clm-compact`) and the TUI plugin (`tui.ts`: the `/clm` panel). `opencode plugin`
writes the spec to both files. By hand, add it to both `plugin` lists; options go on the
`opencode.json` entry only, and the TUI plugin reads them from there:

```jsonc
// opencode.json
{ "plugin": [["opencode-clm", { "budget": "64k" }]] }
// tui.json
{ "plugin": ["opencode-clm"] }
```

From a local clone, use `file:///path/to/opencode-clm/index.ts` and
`file:///path/to/opencode-clm/tui.ts`. Tested with OpenCode 1.18.34.

## Quick start

| command | what it does |
|---------|--------------|
| `/clm` | open the panel: **overview** (context size per request + every accepted edit) <br><img src="https://raw.githubusercontent.com/bcmyguest/opencode-clm/main/.github/images/overview.png" alt="The overview page: context size per request, with the requests after which the model edited its context" width="720"> <br> **input** (what the next request contains) · **edits** (per-revision side-by-side diff) <br><img src="https://raw.githubusercontent.com/bcmyguest/opencode-clm/main/.github/images/edits.png" alt="The edits page: a tool result before and after the model shortened it" width="720"> |
| `/clm status` | a toast: on or off, revision, last request size, budget, fixed overhead, last outcome |
| `/clm config` | open **settings**; `/clm config <setting> <value>` changes one, `/clm config reset` drops this session's changes <br><img src="https://raw.githubusercontent.com/bcmyguest/opencode-clm/main/.github/images/settings.png" alt="The settings page: sizes, files, and every setting" width="720"> |
| `/clm-compact [instructions]` | ask the model to compact its own context now; anything you add (e.g. what to keep) is passed along. The result shows on the **edits** page |
| `/clm on` / `off` / `reset` / `path` | enable, use raw context, discard the accepted revision, show the mirror's path |

With the TUI plugin, typed `/clm …` lines run in the TUI and cost no model turn. Only
`/clm reset` reaches the server command, which costs one turn.

In the panel: `1–4` or `Tab` switch pages, `← →` step through the overview's markers or
the edits page's revisions, `z` zooms the chart, `Enter` opens the selection, `r`
reloads, `q` closes.

## Docs

- [How it works](docs/how-it-works.md) — the mirror, what runs without the model, the panel, model and server support, safety.
- [Configuration](docs/configuration.md) — budget, reserve, reminders, gate, guard and the other settings.
- [Architecture](docs/architecture.md) — modules, session files, design notes, known limitations.
- [Development](docs/development.md) — setup, checks, the integration suites, releasing.

## Citation

If you use opencode-clm in your research, please cite
[Context Language Models](https://arxiv.org/abs/2609.37725):

```bibtex
@article{shao2026context,
  title   = {Context Language Models},
  author  = {Shao, Rulin and Shen, Shannon Zejiang and Yin, Junjie Oscar and Li, Yuetai and
             Wang, Minheng and Ivison, Hamish and Poovendran, Radha and Lambert, Nathan and
             Xiao, Teng and Lewis, Mike and Yih, Wen-tau and Zettlemoyer, Luke and Koh, Pang Wei},
  journal = {arXiv preprint arXiv:2609.37725},
  year    = {2026}
}
```

## Credits

- [pi-clm](https://github.com/lolipopshock/pi-clm) 1.0.0 (MIT, Copyright 2026 Emanuel
  Casco): the design and most of the code derive from it, the `/clm` panel included, and
  most model-facing text is adapted from it. [NOTICE](NOTICE) lists the files.
- [facebookresearch/context-language-models](https://github.com/facebookresearch/context-language-models)
  (CC BY-NC 4.0): this package copies no text from it; the `fit` / `shrink` edit gate and
  the default 25/50/75% reminder steps follow its harness design. This package is not
  licensed under CC BY-NC and is not endorsed by its authors.
- Claude Code (Claude Opus) wrote the code and documentation; the maintainer has not
  hand-reviewed them.

## License

MIT. See [LICENSE](LICENSE), which includes the pi-clm notice, and [NOTICE](NOTICE).
