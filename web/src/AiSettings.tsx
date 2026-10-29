import ShelfButton from './ShelfButton';
import ShelfSwitch from './ShelfSwitch';
import { useEffect, useState, type ReactNode } from 'react';
import { Boxes, Check, ChevronDown, ChevronUp, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import * as Select from '@radix-ui/react-select';
import { request } from './api';
import ShelfSelect from './ShelfSelect';
import { aiLanguages, resolveAiModel, saveAiPreferences, useAiPreferences, type AiPreferences, type AiStatus } from './ai-preferences';

type Props = { section: 'ai-provider' | 'ai-models' | 'ai-behavior'; onNotice: (text: string) => void; onError: (text: string) => void };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function SettingsRow({ label, description, children }: { label: string; description: string; children: ReactNode }) {
  return <div className="setting-row"><div><strong>{label}</strong><small>{description}</small></div>{children}</div>;
}

export default function AiSettings({ section, onNotice, onError }: Props) {
  const preferences = useAiPreferences();
  const [draft, setDraft] = useState<AiPreferences>(preferences);
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [statusError, setStatusError] = useState('');
  useEffect(() => { setDraft(preferences); }, [preferences, section]);
  useEffect(() => {
    if (section === 'ai-behavior') return;
    let active = true;
    setLoading(true); setStatusError('');
    void request<AiStatus>('/ai/status').then(next => { if (active) setStatus(next); })
      .catch(() => { if (active) { setStatus(null); setStatusError('无法连接 Magpie，请确认已打开后重试。'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [section, revision]);
  const models = status?.models || [];
  const save = () => {
    try {
      if (section === 'ai-models') {
        const chatModel = resolveAiModel(draft.chatModel, models);
        const summaryModel = resolveAiModel(draft.summaryModel, models);
        const translationModel = resolveAiModel(draft.translationModel, models);
        if (!chatModel || !summaryModel || !translationModel) throw new Error('请选择可用的对话模型、Skill 分析模型和描述与翻译模型。');
        saveAiPreferences({ chatModel, summaryModel, translationModel });
        onNotice('默认模型已保存。');
      } else {
        saveAiPreferences({ enabled: draft.enabled, targetLanguage: draft.targetLanguage, summaryContext: draft.summaryContext });
        onNotice('AI 设置已保存。');
      }
    } catch (error) { onError(errorMessage(error)); }
  };
  const modelPicker = (key: 'chatModel' | 'summaryModel' | 'translationModel', label: string) => {
    const value = draft[key] || models[0]?.id || '';
    const selected = models.find(model => model.id === value);
    const option = (name: string, id: string) => <span className="ai-model-option"><strong>{name}</strong><small>Magpie · {id}</small></span>;
    return <Select.Root value={value} disabled={loading || !models.length} onValueChange={next => setDraft(current => ({ ...current, [key]: next }))}>
      <Select.Trigger type="button" className="shelf-select-trigger ai-model-picker" data-slot="select-trigger" data-value={value} aria-label={label} aria-autocomplete="none">
        <Select.Value data-slot="select-value">{selected ? option(selected.name || selected.id, selected.id) : `未启用：${value}（请重新选择）`}</Select.Value>
        <Select.Icon asChild><ChevronDown aria-hidden="true" className="shelf-select-icon" data-slot="select-icon" /></Select.Icon>
      </Select.Trigger>
      <Select.Portal><Select.Content aria-label={label} className="shelf-select-content" data-slot="select-content" position="popper" sideOffset={4} collisionPadding={8} onEscapeKeyDown={event => event.stopPropagation()} onKeyDown={event => { if (event.key === 'Escape' || event.key === 'Tab') event.stopPropagation(); }}>
        <Select.ScrollUpButton className="shelf-select-scroll-button" data-slot="select-scroll-up-button"><ChevronUp aria-hidden="true" /></Select.ScrollUpButton>
        <Select.Viewport className="shelf-select-viewport" data-slot="select-viewport">
          {!selected && value && <Select.Item value={value} disabled className="shelf-select-item" data-slot="select-item" data-value={value}><span className="shelf-select-indicator" data-slot="select-item-indicator"><Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator></span><Select.ItemText>未启用：{value}（请重新选择）</Select.ItemText></Select.Item>}
          {models.map(model => <Select.Item key={model.id} value={model.id} className="shelf-select-item" data-slot="select-item" data-value={model.id}><span className="shelf-select-indicator" data-slot="select-item-indicator"><Select.ItemIndicator><Check aria-hidden="true" /></Select.ItemIndicator></span><Select.ItemText>{option(model.name || model.id, model.id)}</Select.ItemText></Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="shelf-select-scroll-button" data-slot="select-scroll-down-button"><ChevronDown aria-hidden="true" /></Select.ScrollDownButton>
      </Select.Content></Select.Portal>
    </Select.Root>;
  };
  const title = section === 'ai-provider' ? '模型服务' : section === 'ai-models' ? '默认模型' : 'AI 行为';
  const readiness = loading ? '读取中' : status?.available ? '已就绪' : '未连接';
  if (section === 'ai-provider') return <div className="ai-provider-browser" data-testid="settings-ai-provider">
    <aside aria-label="服务商"><p>服务商</p><button type="button" aria-current="page"><span className="ai-provider-mark"><Sparkles /></span><span><strong>Magpie</strong><small>{preferences.enabled ? readiness : '已配置 · 已停用'}</small></span><i data-configured={preferences.enabled && status?.available} /></button></aside>
    <div className="settings-page"><header className="settings-page-header"><h2>Magpie</h2><span className={preferences.enabled && status?.available ? 'is-success' : 'is-muted'}>{preferences.enabled ? readiness : '已配置 · 已停用'}</span></header>
      <div className="ai-provider-form"><section className="ai-provider-section"><h3>服务状态</h3><div className="setting-rows"><SettingsRow label="启用 Magpie" description="停用后仍保留配置，但这个服务不会出现在模型选择和 AI 请求中。"><ShelfSwitch aria-label="启用 AI 功能" checked={preferences.enabled} onCheckedChange={enabled => { try { saveAiPreferences({ enabled }); } catch (error) { onError(errorMessage(error)); } }} /></SettingsRow></div></section>
      <section className="ai-provider-section"><h3>模型连接</h3><div className="setting-rows"><SettingsRow label="连接状态" description="服务商、账号和模型请在 Magpie 中管理。"><span role="status">{loading ? '正在连接…' : status?.available ? '已连接' : statusError || status?.reason || '尚未连接'}</span></SettingsRow></div></section></div>
      <section className="ai-provider-section"><div className="ai-provider-section-heading"><div><h3>模型清单</h3><p>已启用的模型会进入默认模型选择。</p></div><ShelfButton variant="outline" size="sm" data-slot="button" data-size="sm" onClick={() => setRevision(value => value + 1)} disabled={loading}>{loading ? <Loader2 className="spin" /> : <RefreshCw />}刷新模型</ShelfButton></div><div className="ai-provider-models">{models.length ? models.map(model => <div key={model.id}><span><strong>{model.name || model.id}</strong><small>{model.id}</small></span><div><span className="ai-model-verification" data-state="available">已启用</span></div></div>) : <div><span className="settings-page-description">{loading ? '正在读取模型列表…' : '暂无可用模型，请在 Magpie 中启用模型后刷新。'}</span></div>}</div></section>
    </div>
  </div>;
  return <div className="settings-page" data-testid={`settings-${section}`}>
    <header className="settings-page-header"><h2>{title}</h2>{section === 'ai-behavior' && <span className={preferences.enabled ? 'is-success' : 'is-muted'}>{preferences.enabled ? '已启用' : '已停用'}</span>}</header>
    {section === 'ai-models' ? <>
      {loading && <p className="loading-line"><Loader2 size={14} className="spin" />读取 Magpie 可用模型…</p>}
      {!loading && !models.length && <div className="ai-model-empty"><Boxes /><strong>没有已启用的模型</strong><p>{statusError || status?.reason || '请先在 Magpie 中启用文本模型。'}</p></div>}
      {models.length > 0 && <div className="setting-rows ai-model-role-list">
        <SettingsRow label="对话模型" description="用于通用对话，以及附带 Skill 上下文的问题。">{modelPicker('chatModel', '对话模型')}</SettingsRow>
        <SettingsRow label="Skill 分析模型" description="用于阅读 Skill 文件，分析能力、规范与限制。">{modelPicker('summaryModel', 'Skill 分析模型')}</SettingsRow>
        <SettingsRow label="描述与翻译模型" description="用于生成简洁描述和翻译，强调稳定、准确的措辞。">{modelPicker('translationModel', '描述与翻译模型')}</SettingsRow>
      </div>}
      {[draft.chatModel, draft.summaryModel, draft.translationModel].some(model => model && !models.some(available => available.id === model)) && !loading && <p className="settings-page-description" role="alert">已保存的模型暂不可用，请重新选择。</p>}
      <div className="ai-settings-actions is-end"><ShelfButton variant="default" size="sm" data-slot="button" data-size="sm" onClick={save} disabled={loading || !resolveAiModel(draft.chatModel, models) || !resolveAiModel(draft.summaryModel, models) || !resolveAiModel(draft.translationModel, models)}>保存默认模型</ShelfButton></div>
    </> : <>
      <p className="settings-page-description">设置总结和翻译的默认语言与上下文。</p>
      <section className="settings-section"><h3>AI 行为</h3><div className="setting-rows">
        <SettingsRow label="默认输出语言" description="除非另选翻译目标，否则助手会使用这个语言。"><ShelfSelect className="setting-select" aria-label="默认输出语言" value={draft.targetLanguage} onValueChange={value => setDraft(current => ({ ...current, targetLanguage: value }))} options={aiLanguages.map(([value, label]) => ({ value, label }))} /></SettingsRow>
        <SettingsRow label="上下文范围" description="选择总结时使用的 Skill 文本范围。"><ShelfSelect className="setting-select" aria-label="上下文范围" value={draft.summaryContext} onValueChange={value => setDraft(current => ({ ...current, summaryContext: value as AiPreferences['summaryContext'] }))} options={[{ value: 'skill-md', label: '仅 SKILL.md' }, { value: 'description', label: '仅原始描述' }]} /></SettingsRow>
      </div></section>
      <div className="ai-settings-actions is-end"><ShelfButton variant="default" size="sm" data-slot="button" data-size="sm" onClick={save}>保存 AI 设置</ShelfButton></div>
      <details className="settings-privacy-note"><summary>隐私与费用</summary><p>仅在你主动发送对话、生成描述、分析或翻译时调用模型。对话可以附上所选 Skill 的 SKILL.md 和会话内容；生成描述与分析使用所选 Skill 文本，描述翻译只发送原始描述。内容经 Magpie 发送给所选模型服务，并按该服务计费。</p></details>
    </>}
  </div>;
}
