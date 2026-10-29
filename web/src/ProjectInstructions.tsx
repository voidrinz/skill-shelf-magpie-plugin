import { useEffect, useId, useState } from 'react';
import { BookOpen, Check, Link2, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import ShelfButton from './ShelfButton';
import ShelfDialog, { DialogTitle, DialogDescription } from './ShelfDialog';
import { request } from './api';
import type { Project } from './types';
import { t } from './desktop-ui';
import './project-instructions.css';

export type ProjectInstructionName = 'AGENTS.md' | 'CLAUDE.md';
export type ProjectInstructionFile = { name: ProjectInstructionName; content: string; exists: boolean; readOnly: boolean; revision: string | null };
export type ProjectInstructions = { projectId: string; projectPath: string; files: Record<ProjectInstructionName, ProjectInstructionFile>; claudeUsesAgents: boolean };
type Props = { project: Pick<Project, 'id' | 'name' | 'path'>; onNotice?: (message: string) => void };
const names: ProjectInstructionName[] = ['AGENTS.md', 'CLAUDE.md'];
const emptyDrafts = { 'AGENTS.md': '', 'CLAUDE.md': '' };

function message(caught: unknown) {
  const value = caught instanceof Error ? caught.message : String(caught);
  if (value.includes('changed externally')) return '文件已在其他编辑器中修改，当前草稿已保留。请先复制草稿，再重新打开并与最新文件合并。';
  if (value.includes('must be saved first')) return '请先保存非空的 AGENTS.md，再连接 Claude。';
  if (value.includes('read-only')) return '无法在此编辑该文件：它可能是符号链接、受保护、过大或非文本文件。';
  if (value.includes('no longer available')) return '该项目已不可用，请检查目录后重新打开编辑器。';
  return '无法读取或保存指令，请检查项目目录和文件权限。';
}

export function ProjectInstructionsButton({ project, onNotice, disabled = false }: Props & { disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <ShelfButton size="sm" variant="outline" disabled={disabled} onClick={() => setOpen(true)}><BookOpen />{t('desktop.instructions.action')}</ShelfButton>
    {open && <ProjectInstructionsEditor key={project.id} project={project} onNotice={onNotice} onClose={() => setOpen(false)} />}
  </>;
}

export function ProjectInstructionsEditor({ project, onClose, onNotice }: Props & { onClose: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const tabsId = useId();
  const [snapshot, setSnapshot] = useState<ProjectInstructions | null>(null);
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [selected, setSelected] = useState<ProjectInstructionName>('AGENTS.md');
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [discard, setDiscard] = useState(false);
  const endpoint = `/projects/${encodeURIComponent(project.id)}/instructions`;
  const dirty = Boolean(snapshot && names.some(name => drafts[name] !== snapshot.files[name].content));
  const current = snapshot?.files[selected];
  const currentDirty = Boolean(current && current.content !== drafts[selected]);

  function accept(next: ProjectInstructions) {
    setSnapshot(next);
    setDrafts({ 'AGENTS.md': next.files['AGENTS.md'].content, 'CLAUDE.md': next.files['CLAUDE.md'].content });
  }


  useEffect(() => {
    let active = true;
    setBusy('load'); setError(''); setNotice(''); setSnapshot(null); setDrafts(emptyDrafts); setDiscard(false);
    void request<ProjectInstructions>(endpoint).then(next => { if (active) accept(next); })
      .catch(caught => { if (active) setError(message(caught)); })
      .finally(() => { if (active) setBusy(''); });
    return () => { active = false; };
  }, [endpoint]);

  async function reload() {
    if (dirty || busy) return;
    setBusy('load'); setError(''); setNotice('');
    try { accept(await request<ProjectInstructions>(endpoint)); }
    catch (caught) { setError(message(caught)); }
    finally { setBusy(''); }
  }

  async function save() {
    if (!current || current.readOnly || busy) return;
    setBusy('save'); setError(''); setNotice('');
    try {
      const next = await request<ProjectInstructions>(endpoint, 'PUT', { name: selected, content: drafts[selected], expectedRevision: current.revision });
      setSnapshot(next);
      // Saving one file must not discard an unsaved draft in the other tab.
      setDrafts(previous => ({ ...previous, [selected]: next.files[selected].content }));
      setNotice(`${selected} 已保存。`); onNotice?.(`${selected} 已保存。`);
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(''); }
  }

  async function connect() {
    if (!snapshot || dirty || busy) return;
    setBusy('connect'); setError(''); setNotice('');
    try {
      accept(await request<ProjectInstructions>(`${endpoint}/claude`, 'POST', { expectedRevision: snapshot.files['CLAUDE.md'].revision }));
      setNotice('Claude 已连接 AGENTS.md。'); onNotice?.('Claude 已连接 AGENTS.md。');
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(''); }
  }

  function close() {
    if (busy) return;
    if (dirty) setDiscard(true);
    else onClose();
  }

  return <ShelfDialog className="project-instructions-dialog" onClose={close} locked={Boolean(busy)} aria-labelledby={titleId} aria-describedby={descriptionId}>
    <div data-slot="dialog-header"><DialogTitle id={titleId} data-slot="dialog-title">{project.name} / 项目指令</DialogTitle><DialogDescription id={descriptionId} data-slot="dialog-description">将项目的通用规则写入 AGENTS.md，再让 Claude 通过 CLAUDE.md 读取同一份规则。</DialogDescription></div>
    <code className="project-instructions-path" title={snapshot?.projectPath || project.path}>{snapshot?.projectPath || project.path}</code>
    {error && <p className="project-instructions-error" role="alert">{error}</p>}
    {notice && <p className="project-instructions-notice" role="status">{notice}</p>}
    <section className="project-instructions-bridge"><div><strong>Claude 兼容</strong><p>{snapshot?.claudeUsesAgents ? 'CLAUDE.md 已引用 AGENTS.md。' : '在 CLAUDE.md 中追加 @AGENTS.md，保留原有指令。请先保存 AGENTS.md。'}</p></div>
      {snapshot?.claudeUsesAgents ? <span className="project-instructions-linked"><Check />已连接</span>
        : <ShelfButton variant="outline" size="sm" onClick={() => void connect()} disabled={Boolean(busy) || dirty || !snapshot?.files['AGENTS.md'].content.trim() || snapshot.files['CLAUDE.md'].readOnly}>{busy === 'connect' ? <LoaderCircle className="spin" /> : <Link2 />}连接 Claude</ShelfButton>}
    </section>
    <div className="project-instructions-tabs"><div className="project-instructions-files"><div role="tablist" aria-label="项目指令文件">{names.map(name => <ShelfButton key={name} id={`${tabsId}-${name}`} role="tab" aria-selected={selected === name} aria-controls={`${tabsId}-panel`} tabIndex={selected === name ? 0 : -1} variant={selected === name ? 'secondary' : 'ghost'} size="sm" disabled={Boolean(busy)} onClick={() => setSelected(name)} onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 'AGENTS.md' : event.key === 'End' ? 'CLAUDE.md' : selected === 'AGENTS.md' ? 'CLAUDE.md' : 'AGENTS.md';
      setSelected(next); document.getElementById(`${tabsId}-${next}`)?.focus();
    }}>{name}{snapshot && drafts[name] !== snapshot.files[name].content ? ' *' : ''}</ShelfButton>)}</div>
      <ShelfButton size="icon-sm" variant="ghost" disabled={Boolean(busy) || dirty} aria-label="重新读取文件" onClick={() => void reload()}><RefreshCw /></ShelfButton>
    </div><div className="project-instructions-tab-content" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${selected}`}>
      <p className="project-instructions-file-hint">{!current ? busy === 'load' ? '正在读取项目指令…' : '' : current.readOnly ? '无法在此编辑该文件：它可能是符号链接、受保护、过大或非文本文件。' : current.exists ? '编辑项目根目录中的文件，保存前会备份原有内容。' : '文件尚不存在，保存后会在项目根目录中创建。'}</p>
      <textarea className="project-instructions-editor" aria-label={`编辑 ${selected}`} value={drafts[selected]} disabled={Boolean(busy) || !current} readOnly={current?.readOnly} spellCheck={false}
        placeholder={selected === 'AGENTS.md' ? '# 项目指令\n\n描述项目约定、常用命令，以及编码 Agent 应遵循的规则。' : '@AGENTS.md'} onChange={event => { setDiscard(false); setNotice(''); setDrafts(previous => ({ ...previous, [selected]: event.target.value })); }} />
    </div></div>
    {discard && <p role="alert" className="project-instructions-error">放弃未保存的修改并关闭编辑器？</p>}
    <div data-slot="dialog-footer">{discard ? <><ShelfButton variant="ghost" onClick={() => setDiscard(false)}>继续编辑</ShelfButton><ShelfButton variant="destructive" onClick={onClose}>放弃修改</ShelfButton></>
      : <><span className="project-instructions-unsaved">{dirty ? '有未保存的修改' : snapshot ? '没有未保存的修改' : ''}</span><ShelfButton variant="ghost" disabled={Boolean(busy)} onClick={close}>关闭</ShelfButton><ShelfButton disabled={Boolean(busy) || !current || current.readOnly || (!currentDirty && current.exists)} onClick={() => void save()}>{busy === 'save' ? <LoaderCircle className="spin" /> : <Save />}保存 {selected}</ShelfButton></>}
    </div>
  </ShelfDialog>;
}
