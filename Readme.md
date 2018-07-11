# [C](#)onqure [o](#)f  [C](#)ompletion

[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fneoclide%2Fcoc.nvim.svg?type=shield)](https://app.fossa.io/projects/git%2Bgithub.com%2Fneoclide%2Fcoc.nvim?ref=badge_shield)

Coc is a completion framework of [neovim](https://github.com/neovim/neovim)
while providing featured language server support.

Refer to [wiki page](https://github.com/neoclide/coc.nvim/wiki) for detail documentation.

## [Installation](https://github.com/neoclide/coc.nvim/wiki/Install-coc.nvim)

**Note:** neovim 0.3.0 is required for buffer-updates feature.

## Pros.

* Async generate complete items
* Fuzzy match with smart case.
* Full featured completion support defined in LSP.
* Built in language server extensions, like tsserver, tslint etc.
* Custom language server configuration support.

## Language server features

Check out the official specification at https://microsoft.github.io/language-server-protocol/specification.

* ✓ Request cancellation support
* ✓ Full features of workspace (except workspace folders related)
* ✓ Full features of text synchronization
* ✓ Full features of window support
* ✓ Diagnostics
* ✗ Telemetry
* ✓ Completion
* ✓ Completion resolve
* ✓ Hover
* ✓ Signature help
* ✓ Definition
* ✓ Type definition
* ✓ Implementation
* ✓ References
* ✓ Document highlight
* ✓ Document symbol
* ✓ Code action
* ✓ CodeLens
* ✓ CodeLens resolve
* ✗ Document link
* ✗ Document link resolve
* ✗ Document color
* ✗ Color Presentation
* ✓ Document Formatting
* ✓ Document Range Formatting
* ✗ Document on Type Formatting
* ✓ Rename

**Note:** different server could have different capabilities.

## Completion sources

### Common sources


Name         | Description                                             | Use cache   | Default filetypes
------------ | -------------                                           | ------------|------------
`around`     | Words of current buffer.                                | ✗           | all
`buffer`     | Words of none current buffer.                           | ✓           | all
`dictionary` | Words from files of local `dictionary` option.          | ✓           | all
`tag`        | Words from `taglist` of current buffer.                 | ✓           | all
`file`       | Filename completion, auto detected.                     | ✗           | all
`omni`       | Invoke `omnifunc` of current buffer for complete items. | ✗           | []
`word`       | Words from google 10000 english repo.                   | ✓           | all
`emoji`      | Eomji characters.                                       | ✓           | ['markdown']
`include`    | Full path completion for include file paths.            | ✗           | [Limited](/src/source/include_resolve)

`omni` source could be slow, it requires configuration for `filetypes` to work.

### Vim sources

Vim sources are implemented in viml, and usually requires other vim plugin to
work.

Name           |Description                |Filetype     | Requirement
------------   |------------               |------------ | -------------
ultisnips      |Snippets name completion   |User defined | Install [ultisnips](https://github.com/SirVer/ultisnips)
neco           |VimL completion            |vim          | Install [neco-vim](https://github.com/Shougo/neco-vim)

## Trouble shooting

When you find the plugin is not working as you would expected, run command
`:checkhealth` and make use that output from `coc.nvim` are `OK`.

To get the log file, run shell command:

    node -e 'console.log(path.join(os.tmpdir(), "coc-nvim.log"))'

You can also use environment variable to change logger behaviour:

* `$NVIM_COC_LOG_LEVEL` set to `debug` for debug messages.
* `$NVIM_COC_LOG_FILE` set the file path of log file.

Note: Coc would disable itself when there is vim error during autocmd.

## LICENSE

[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Fneoclide%2Fcoc.nvim.svg?type=large)](https://app.fossa.io/projects/git%2Bgithub.com%2Fneoclide%2Fcoc.nvim?ref=badge_large)
