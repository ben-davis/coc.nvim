import { Buffer, NeovimClient as Neovim } from '@chemzqm/neovim'
import deepEqual from 'deep-equal'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DidChangeTextDocumentParams, Disposable, Emitter, Event, FormattingOptions, Location, Position, TextDocument, TextDocumentEdit, TextDocumentSaveReason, TextEdit, WorkspaceEdit, WorkspaceFolder } from 'vscode-languageserver-protocol'
import Uri from 'vscode-uri'
import Configurations, { parseContentFromFile } from './configurations'
import ConfigurationShape from './model/configurationShape'
import Document from './model/document'
import FileSystemWatcher from './model/fileSystemWatcher'
import JobManager from './model/jobManager'
import ModuleManager from './model/moduleManager'
import BufferChannel from './model/outputChannel'
import WillSaveUntilHandler from './model/willSaveHandler'
import Sources from './sources'
import { ChangeInfo, ConfigurationTarget, DocumentInfo, EditerState, IConfigurationData, IWorkspace, MsgTypes, OutputChannel, QuickfixItem, TerminalResult, TextDocumentWillSaveEvent, WinEnter, WorkspaceConfiguration } from './types'
import { resolveRoot, writeFile } from './util/fs'
import { disposeAll, echoErr, echoMessage, echoWarning, isSupportedScheme, wait } from './util/index'
import { byteIndex } from './util/string'
import { watchFiles } from './util/watch'
import Watchman from './watchman'
import uuidv1 = require('uuid/v1')
const logger = require('./util/logger')('workspace')
const CONFIG_FILE_NAME = 'coc-settings.json'
const isPkg = process.hasOwnProperty('pkg')

// global neovim settings
export interface VimSettings {
  completeOpt: string
  pluginRoot: string
  isVim: boolean
}

export class Workspace implements IWorkspace {
  public bufnr: number
  public moduleManager: ModuleManager
  public jobManager: JobManager
  public sources: Sources
  public readonly nvim: Neovim
  public readonly emitter: EventEmitter

  private willSaveUntilHandler: WillSaveUntilHandler
  private vimSettings: VimSettings
  private _cwd = process.cwd()
  private _initialized = false
  private buffers: Map<number, Document> = new Map()
  private checking: Set<number> = new Set()
  private outputChannels: Map<string, OutputChannel> = new Map()
  private configurationShape: ConfigurationShape
  private _configurations: Configurations
  private disposables: Disposable[] = []
  private configFiles: string[] = []

  private _onDidBufWinEnter = new Emitter<WinEnter>()
  private _onDidEnterDocument = new Emitter<DocumentInfo>()
  private _onDidAddDocument = new Emitter<TextDocument>()
  private _onDidCloseDocument = new Emitter<TextDocument>()
  private _onDidChangeDocument = new Emitter<DidChangeTextDocumentParams>()
  private _onWillSaveDocument = new Emitter<TextDocumentWillSaveEvent>()
  private _onDidSaveDocument = new Emitter<TextDocument>()
  private _onDidChangeConfiguration = new Emitter<WorkspaceConfiguration>()
  private _onDidWorkspaceInitialized = new Emitter<void>()
  private _onDidModuleInstalled = new Emitter<string>()

  public readonly onDidEnterTextDocument: Event<DocumentInfo> = this._onDidEnterDocument.event
  public readonly onDidOpenTextDocument: Event<TextDocument> = this._onDidAddDocument.event
  public readonly onDidCloseTextDocument: Event<TextDocument> = this._onDidCloseDocument.event
  public readonly onDidChangeTextDocument: Event<DidChangeTextDocumentParams> = this._onDidChangeDocument.event
  public readonly onWillSaveTextDocument: Event<TextDocumentWillSaveEvent> = this._onWillSaveDocument.event
  public readonly onDidSaveTextDocument: Event<TextDocument> = this._onDidSaveDocument.event
  public readonly onDidChangeConfiguration: Event<WorkspaceConfiguration> = this._onDidChangeConfiguration.event
  public readonly onDidWorkspaceInitialized: Event<void> = this._onDidWorkspaceInitialized.event
  public readonly onDidModuleInstalled: Event<string> = this._onDidModuleInstalled.event
  public readonly onDidBufWinEnter: Event<WinEnter> = this._onDidBufWinEnter.event

  constructor() {
    let config = this.loadConfigurations()
    let configurationShape = this.configurationShape = new ConfigurationShape(this)
    this._configurations = new Configurations(config, configurationShape)
    let moduleManager = this.moduleManager = new ModuleManager()
    this.jobManager = new JobManager(this)
    this.willSaveUntilHandler = new WillSaveUntilHandler(this)
    moduleManager.on('installed', name => {
      this._onDidModuleInstalled.fire(name)
    })
    this.disposables.push(
      watchFiles(this.configFiles, this.onConfigurationChange.bind(this))
    )
  }

  public async init(): Promise<void> {
    this.emitter.on('BufEnter', this.onBufEnter.bind(this))
    this.emitter.on('BufWinEnter', this.onBufWinEnter.bind(this))
    this.emitter.on('DirChanged', this.onDirChanged.bind(this))
    this.emitter.on('BufCreate', this.onBufCreate.bind(this))
    this.emitter.on('BufUnload', this.onBufUnload.bind(this))
    this.emitter.on('BufWritePost', this.onBufWritePost.bind(this))
    this.emitter.on('BufWritePre', this.onBufWritePre.bind(this))
    this.emitter.on('OptionSet', this.onOptionSet.bind(this))
    this.emitter.on('FileType', this.onFileTypeChange.bind(this))
    this.emitter.on('CursorHold', this.checkBuffer.bind(this))
    this.emitter.on('TextChanged', this.checkBuffer.bind(this))
    this.emitter.on('notification', (method, args) => {
      switch (method) {
        case 'TerminalResult':
          this.moduleManager.handleTerminalResult(args[0])
          break
        case 'JobResult':
          let [id, data] = args
          this.jobManager.handleResult(id as number, data as string)
          break
      }
    })
    this.vimSettings = await this.nvim.call('coc#util#vim_info') as VimSettings
    let buffers = await this.nvim.buffers
    await Promise.all(buffers.map(buf => {
      return this.onBufCreate(buf)
    }))
    let buffer = await this.nvim.buffer
    this.bufnr = buffer.id
    this._onDidWorkspaceInitialized.fire(void 0)
    this._initialized = true
    if (this.isVim) this.initVimEvents()
    this.onBufEnter(buffer.id) // tslint:disable-line
    let winid = await this.nvim.call('win_getid')
    let name = await buffer.name
    this.onBufWinEnter(name, winid) // tslint:disable-line
  }

  public getConfigFile(target: ConfigurationTarget): string {
    if (target == ConfigurationTarget.Global) {
      return this.configFiles[0]
    }
    if (target == ConfigurationTarget.User) {
      return this.configFiles[1]
    }
    return this.configFiles[2]
  }

  public get cwd(): string {
    return this._cwd
  }

  public get root(): string {
    let { cwd, bufnr } = this
    let dir: string
    if (bufnr) {
      let document = this.getDocument(bufnr)
      if (document && document.schema == 'file') dir = path.dirname(Uri.parse(document.uri).fsPath)
    }
    dir = dir || cwd
    return resolveRoot(dir, ['.vim', '.git', '.hg', '.watchmanconfig'], os.homedir()) || cwd
  }

  public get workspaceFolder(): WorkspaceFolder {
    let { root } = this
    return {
      uri: Uri.file(root).toString(),
      name: path.basename(root)
    }
  }

  public get textDocuments(): TextDocument[] {
    let docs = []
    for (let b of this.buffers.values()) {
      if (b.textDocument != null) {
        docs.push(b.textDocument)
      }
    }
    return docs
  }

  public get documents(): Document[] {
    return Array.from(this.buffers.values())
  }

  public get channelNames(): string[] {
    return Array.from(this.outputChannels.keys())
  }

  public get pluginRoot(): string {
    return isPkg ? path.resolve(process.execPath, '../..') : path.dirname(__dirname)
  }

  public get isVim(): boolean {
    return this.vimSettings.isVim
  }

  public get isNvim(): boolean {
    return !this.vimSettings.isVim
  }

  public get completeOpt(): string {
    return this.vimSettings.completeOpt
  }

  public get initialized(): boolean {
    return this._initialized
  }

  public get filetypes(): Set<string> {
    let res = new Set() as Set<string>
    for (let doc of this.documents) {
      res.add(doc.filetype)
    }
    return res
  }

  public getVimSetting<K extends keyof VimSettings>(name: K): VimSettings[K] {
    return this.vimSettings[name]
  }

  public createFileSystemWatcher(globPattern: string, ignoreCreate?: boolean, ignoreChange?: boolean, ignoreDelete?: boolean): FileSystemWatcher {
    const preferences = this.getConfiguration('coc.preferences')
    const watchmanPath = Watchman.getBinaryPath(preferences.get<string>('watchmanPath', ''))
    let promise = watchmanPath ? Watchman.createClient(watchmanPath, this.root) : Promise.resolve(null)
    return new FileSystemWatcher(
      promise,
      globPattern,
      !!ignoreCreate,
      !!ignoreChange,
      !!ignoreDelete
    )
  }

  public getConfiguration(section?: string, _resource?: string): WorkspaceConfiguration {
    return this._configurations.getConfiguration(section)
  }

  public getDocument(uri: string | number): Document
  public getDocument(bufnr: number): Document | null {
    if (typeof bufnr === 'number') {
      return this.buffers.get(bufnr)
    }
    for (let doc of this.buffers.values()) {
      if (doc && doc.uri === bufnr) return doc
    }
    return null
  }

  public async getOffset(): Promise<number> {
    let buffer = await this.nvim.buffer
    let document = this.getDocument(buffer.id)
    if (!document) return null
    let [, lnum, col] = await this.nvim.call('getcurpos')
    let line = document.getline(lnum - 1)
    if (line == null) return null
    let character = col == 1 ? 0 : byteIndex(line, col - 1)
    return document.textDocument.offsetAt({
      line: lnum - 1,
      character
    })
  }

  public async applyEdit(edit: WorkspaceEdit): Promise<boolean> {
    let { nvim } = this
    let { documentChanges, changes } = edit
    let curpos = await nvim.call('getcurpos')
    if (!this.validteDocumentChanges(documentChanges)) return false
    if (!this.validateChanges(changes)) return false
    if (documentChanges && documentChanges.length) {
      let n = 0
      for (let change of documentChanges) {
        let { textDocument, edits } = change
        let doc = this.getDocument(textDocument.uri)
        await doc.applyEdits(nvim, edits)
      }
      echoMessage(nvim, `${n} buffers changed!`)
    }
    if (changes) {
      let keys = Object.keys(changes)
      if (!keys.length) return false
      let n = this.fileCount(changes)
      if (n > 0) {
        let c = await nvim.call('coc#util#prompt_change', [keys.length])
        if (c != 1) return false
      }
      let filetype = await nvim.buffer.getOption('filetype') as string
      let encoding = await this.getFileEncoding()
      for (let uri of Object.keys(changes)) {
        let edits = changes[uri]
        let filepath = Uri.parse(uri).fsPath
        let document = this.getDocument(uri)
        let doc: TextDocument
        if (document) {
          doc = document.textDocument
          await document.applyEdits(nvim, edits)
        } else {
          let content = fs.readFileSync(filepath, encoding)
          doc = TextDocument.create(uri, filetype, 0, content)
          let res = TextDocument.applyEdits(doc, edits)
          await writeFile(filepath, res)
        }
      }
    }
    await nvim.call('setpos', ['.', curpos])
    return true
  }

  public async getQuickfixItem(loc: Location): Promise<QuickfixItem> {
    let { uri, range } = loc
    let { line, character } = range.start
    let fullpath = Uri.parse(uri).fsPath
    let doc = this.getDocument(uri)
    let bufnr = doc ? doc.bufnr : 0
    let text = await this.getLine(uri, line)
    let item: QuickfixItem = {
      filename: fullpath.startsWith(this.cwd) ? path.relative(this.cwd, fullpath) : fullpath,
      lnum: line + 1,
      col: character + 1,
      text
    }
    if (bufnr) item.bufnr = bufnr
    return item
  }

  public async getLine(uri: string, line: number): Promise<string> {
    let document = this.getDocument(uri)
    if (document) return document.getline(line)
    let u = Uri.parse(uri)
    if (u.scheme === 'file') {
      let filepath = u.fsPath
      if (fs.existsSync(filepath)) {
        let lines = await this.nvim.call('readfile', u.fsPath)
        return lines[line] || ''
      }
    }
    return ''
  }

  public async readFile(uri: string): Promise<string> {
    let document = this.getDocument(uri)
    if (document) return document.content
    let u = Uri.parse(uri)
    if (u.scheme === 'file') {
      let filepath = u.fsPath
      if (fs.existsSync(filepath)) {
        let lines = await this.nvim.call('readfile', u.fsPath)
        return lines.join('\n')
      }
    }
    return ''
  }

  public onWillSaveUntil(callback: (event: TextDocumentWillSaveEvent) => void, thisArg: any, clientId: string): Disposable {
    return this.willSaveUntilHandler.addCallback(callback, thisArg, clientId)
  }

  public async echoLines(lines: string[]): Promise<void> {
    let { nvim } = this
    let cmdHeight = (await nvim.getOption('cmdheight') as number)
    if (lines.length > cmdHeight) {
      lines = lines.slice(0, cmdHeight)
      let last = lines[cmdHeight - 1]
      lines[cmdHeight - 1] = `${last} ...`
    }
    let cmd = lines.map(line => {
      return `echo '${line.replace(/'/g, "''")}'`
    }).join('|')
    await nvim.command(cmd)
  }

  public showMessage(msg: string, identify: MsgTypes = 'more'): void {
    if (identify == 'error') {
      return echoErr(this.nvim, msg)
    }
    if (identify == 'warning') {
      return echoWarning(this.nvim, msg)
    }
    return echoMessage(this.nvim, msg)
  }

  public get document(): Promise<Document | null> {
    let { bufnr } = this
    if (bufnr && this.buffers.has(bufnr)) {
      return Promise.resolve(this.buffers.get(bufnr))
    }
    return this.nvim.buffer.then(buffer => {
      this.bufnr = buffer.id
      return this.onBufCreate(buffer).then(() => {
        return this.getDocument(this.bufnr)
      })
    })
  }

  public async getCurrentState(): Promise<EditerState> {
    let document = await this.document
    if (!document) return { document: null, position: null }
    let [, lnum, col] = await this.nvim.call('getcurpos')
    let line = document.getline(lnum - 1)
    if (!line) return { document: null, position: null }
    return {
      document: document.textDocument,
      position: {
        line: lnum - 1,
        character: byteIndex(line, col - 1)
      }
    }
  }

  public async getFormatOptions(uri?: string): Promise<FormattingOptions> {
    let doc = uri ? this.getDocument(uri) : await this.document
    if (!doc) return { tabSize: 2, insertSpaces: true }
    let { buffer } = doc
    let tabSize = await buffer.getOption('tabstop') as number
    let insertSpaces = (await buffer.getOption('expandtab')) == 1
    let options: FormattingOptions = {
      tabSize,
      insertSpaces
    }
    return options
  }

  public async jumpTo(uri: string, position: Position): Promise<void> {
    let { nvim, jumpCommand } = this
    let { line, character } = position
    let cmd = `+call\\ cursor(${line + 1},${character + 1})`
    let filepath = Uri.parse(uri).fsPath
    let bufnr = await nvim.call('bufnr', [filepath])
    if (bufnr != -1 && jumpCommand == 'edit') {
      await nvim.command(`buffer ${cmd} ${bufnr}`)
    } else {
      let cwd = await nvim.call('getcwd')
      let file = filepath.startsWith(cwd) ? path.relative(cwd, filepath) : filepath
      await nvim.command(`exe '${jumpCommand} ${cmd} ' . fnameescape('${file}')`)
    }
  }

  public async createFile(filepath: string, opts: { ignoreIfExists?: boolean } = {}): Promise<void> {
    if (fs.existsSync(filepath) && opts.ignoreIfExists) return
    let uri = Uri.file(filepath).toString()
    let doc = this.getDocument(uri)
    if (doc) return
    let encoding = await this.getFileEncoding()
    fs.writeFileSync(filepath, '', encoding || '')
    if (!doc) await this.openResource(uri)
  }

  public async openResource(uri: string, cmd = 'drop'): Promise<void> {
    let u = Uri.parse(uri)
    // not supported
    if (u.scheme !== 'file') return
    let { nvim } = this
    let filepath = u.fsPath
    let cwd = await nvim.call('getcwd')
    let file = filepath.startsWith(cwd) ? path.relative(cwd, filepath) : filepath
    // edit it even exists
    await nvim.call('coc#util#edit_file', [file, cmd])
  }

  public createOutputChannel(name: string): OutputChannel {
    if (this.outputChannels.has(name)) {
      name = `${name}-${uuidv1()}`
    }
    let channel = new BufferChannel(name, this.nvim)
    this.outputChannels.set(name, channel)
    return channel
  }

  public showOutputChannel(name: string): void {
    let channel = this.outputChannels.get(name)
    if (!channel) {
      echoErr(this.nvim, `Channel "${name}" not found`)
      return
    }
    channel.show(false)
  }

  public async resolveModule(name: string, section: string, silent = false): Promise<string> {
    let res = await this.moduleManager.resolveModule(name)
    if (res) return res
    if (!silent) await this.moduleManager.installModule(name, section)
    return null
  }

  public async runCommand(cmd: string, cwd?: string): Promise<string> {
    return await this.jobManager.runCommand(cmd, cwd)
  }

  public async runTerminalCommand(cmd: string, cwd?: string): Promise<TerminalResult> {
    cwd = cwd || this.root
    return await this.moduleManager.runCommand(cmd, cwd)
  }

  public dispose(): void {
    for (let ch of this.outputChannels.values()) {
      ch.dispose()
    }
    for (let doc of this.buffers.values()) {
      doc.detach().catch(e => {
        logger.error(e)
      })
    }
    Watchman.dispose()
    this.moduleManager.removeAllListeners()
    disposeAll(this.disposables)
  }

  private fileCount(changes: { [uri: string]: TextEdit[] }): number {
    let n = 0
    for (let uri of Object.keys(changes)) {
      if (!this.getDocument(uri)) {
        n = n + 1
      }
    }
    return n
  }

  private onConfigurationChange(): void {
    let { _configurations } = this
    try {
      let config = this.loadConfigurations()
      this._configurations = new Configurations(config, this.configurationShape)
      if (!_configurations || !deepEqual(_configurations, this._configurations)) {
        this._onDidChangeConfiguration.fire(this.getConfiguration())
      }
    } catch (e) {
      logger.error(`Load configuration error: ${e.message}`)
    }
  }

  private validteDocumentChanges(documentChanges: TextDocumentEdit[] | null): boolean {
    if (!documentChanges) return true
    for (let change of documentChanges) {
      let { textDocument } = change
      let { uri, version } = textDocument
      let doc = this.getDocument(uri)
      if (!doc) {
        echoErr(this.nvim, `${uri} not found`)
        return false
      }
      if (doc.version != version) {
        echoErr(this.nvim, `${uri} changed before apply edit`)
        return false
      }
    }
    return true
  }

  private validateChanges(changes: { [uri: string]: TextEdit[] }): boolean {
    if (!changes) return true
    for (let uri of Object.keys(changes)) {
      let scheme = Uri.parse(uri).scheme
      if (!isSupportedScheme(scheme)) {
        echoErr(this.nvim, `Schema of ${uri} not supported.`)
        return false
      }
      let filepath = Uri.parse(uri).fsPath
      if (!this.getDocument(uri) && !fs.existsSync(filepath)) {
        echoErr(this.nvim, `File ${filepath} not exists`)
        return false
      }
    }
    return true
  }

  private loadConfigurations(): IConfigurationData {
    let file = path.join(this.pluginRoot, 'settings.json')
    this.configFiles.push(file)
    let defaultConfig = parseContentFromFile(file)
    let home = process.env.VIMCONFIG
    if (global.hasOwnProperty('__TEST__')) {
      home = path.join(this.pluginRoot, 'src/__tests__')
    }
    file = path.join(home, CONFIG_FILE_NAME)
    this.configFiles.push(file)
    let userConfig = parseContentFromFile(file)
    file = path.join(this.root, '.vim/' + CONFIG_FILE_NAME)
    let workspaceConfig
    if (this.configFiles.indexOf(file) == -1) {
      this.configFiles.push(file)
      workspaceConfig = parseContentFromFile(file)
    } else {
      workspaceConfig = { contents: {} }
    }
    return {
      defaults: defaultConfig,
      user: userConfig,
      workspace: workspaceConfig
    }
  }

  // events for sync buffer of vim
  private initVimEvents(): void {
    let { emitter, nvim } = this
    let lastChar = ''
    let lastTs = null
    emitter.on('InsertCharPre', ch => {
      lastChar = ch
      lastTs = Date.now()
    })
    emitter.on('TextChangedI', bufnr => {
      let doc = this.getDocument(bufnr)
      if (!doc) return
      if (Date.now() - lastTs < 40 && lastChar) {
        nvim.call('coc#util#get_changeinfo', []).then(res => {
          doc.patchChange(res as ChangeInfo)
        }, () => {
          // noop
        })
      } else {
        doc.fetchContent()
      }
      lastChar = null
    })
    emitter.on('TextChanged', bufnr => {
      let doc = this.getDocument(bufnr)
      if (doc) doc.fetchContent()
    })
  }

  private get jumpCommand(): string {
    const preferences = this.getConfiguration('coc.preferences')
    return preferences.get<string>('jumpCommand', 'edit')
  }

  private onBufEnter(bufnr: number): void {
    this.bufnr = bufnr
    let doc = this.buffers.get(bufnr)
    if (!doc) return
    let buf = doc.buffer
    let documentInfo: DocumentInfo = {
      bufnr: buf.id,
      uri: doc.uri,
      languageId: doc.filetype,
    }
    this._onDidEnterDocument.fire(documentInfo)
  }

  private async onBufCreate(buf: number | Buffer): Promise<void> {
    let buffer = typeof buf === 'number' ? this.nvim.createBuffer(buf) : buf
    let loaded = await this.nvim.call('bufloaded', buffer.id)
    if (!loaded) return
    let buftype = await buffer.getOption('buftype') as string
    if (buftype == 'help' || buftype == 'quickfix' || buftype == 'nofile') return
    let doc = this.buffers.get(buffer.id)
    if (doc) {
      // it could be buffer name changed
      await this.onBufUnload(buffer.id)
    }
    let document = new Document(buffer)
    let attached: boolean
    try {
      attached = await document.init(this.nvim, buftype, this.isNvim)
    } catch (e) {
      return
    }
    if (attached) {
      this.buffers.set(buffer.id, document)
      if (isSupportedScheme(document.schema)) {
        this._onDidAddDocument.fire(document.textDocument)
        document.onDocumentChange(({ textDocument, contentChanges }) => {
          let { version, uri } = textDocument
          this._onDidChangeDocument.fire({
            textDocument: { version, uri },
            contentChanges
          })
        })
      }
    }
    logger.debug('buffer created', buffer.id)
  }

  private async onBufWritePost(bufnr: number): Promise<void> {
    let doc = this.buffers.get(bufnr)
    if (!doc || !isSupportedScheme(doc.schema)) return
    this._onDidSaveDocument.fire(doc.textDocument)
  }

  private async onBufUnload(bufnr: number): Promise<void> {
    let doc = this.buffers.get(bufnr)
    if (doc) {
      this.buffers.delete(bufnr)
      await doc.detach()
      if (isSupportedScheme(doc.schema)) {
        this._onDidCloseDocument.fire(doc.textDocument)
      }
    }
    logger.debug('buffer unload', bufnr)
  }

  private async onBufWritePre(bufnr: number): Promise<void> {
    let { nvim } = this
    let doc = this.buffers.get(bufnr)
    if (!doc) return
    await doc.checkDocument()
    if (bufnr == this.bufnr) nvim.call('coc#util#clear', [], true)
    if (doc && isSupportedScheme(doc.schema)) {
      let event: TextDocumentWillSaveEvent = {
        document: doc.textDocument,
        reason: TextDocumentSaveReason.Manual
      }
      this._onWillSaveDocument.fire(event)
      await wait(20)
      try {
        await this.willSaveUntilHandler.handeWillSaveUntil(event)
      } catch (e) {
        echoErr(nvim, e.message)
        logger.error(e.message)
      }
    }
  }

  private onOptionSet(name: string, _oldValue: any, newValue: any): void {
    if (name === 'completeopt') {
      this.vimSettings.completeOpt = newValue
    }
  }

  private onDirChanged(cwd: string): void {
    this._cwd = cwd
    this.onConfigurationChange()
  }

  private onBufWinEnter(filepath: string, winid: number): void {
    let uri = /^\w:/.test(filepath) ? filepath : Uri.file(filepath).toString()
    let doc = this.getDocument(uri)
    this._onDidBufWinEnter.fire({
      document: doc ? doc.textDocument : null,
      winid
    })
  }

  private onFileTypeChange(filetype: string, bufnr: number): void {
    let doc = this.getDocument(bufnr)
    if (!doc) return
    let supported = isSupportedScheme(doc.schema)
    if (supported) this._onDidCloseDocument.fire(doc.textDocument)
    doc.setFiletype(filetype)
    if (supported) this._onDidAddDocument.fire(doc.textDocument)
  }

  private async checkBuffer(bufnr: number): Promise<void> {
    let doc = this.getDocument(bufnr)
    if (!doc) {
      if (this.checking.has(bufnr)) return
      this.checking.add(bufnr)
      this.emitter.emit('BufCreate', bufnr)
      let buf = await this.nvim.buffer
      if (buf.id == bufnr && bufnr != this.bufnr) {
        this.emitter.emit('BufEnter')
      }
      if (buf.id == bufnr) {
        let name = await buf.name
        let winid = await this.nvim.call('bufwinid', '%')
        this.emitter.emit('BufWinEnter', name, winid)
      }
      await wait(50)
      this.checking.delete(bufnr)
    }
  }

  private async getFileEncoding(): Promise<string> {
    let encoding = await this.nvim.getOption('fileencoding') as string
    return encoding ? encoding : 'utf-8'
  }
}

export default new Workspace()
