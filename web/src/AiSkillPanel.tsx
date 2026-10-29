import ShelfButton from './ShelfButton';
import { useEffect, useState } from 'react';
import { Check, Languages, Loader2, ShieldCheck, Sparkles, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { request } from './api';
import ShelfSelect from './ShelfSelect';
import { aiLanguages, readAiPreferences, resolveAiModel, saveAiPreferences, useAiPreferences, type AiPreferences, type AiStatus } from './ai-preferences';
import type { AiAnnotation, AiDraft, Skill } from './types';

type Results = { summary?: AiAnnotation; translations: AiAnnotation[] };
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

function AnnotationText({ text }: { text: string }) {
  return <div className="markdown-body ai-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>[图片：{alt || '未加载'}]</span>, a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> }}>{text}</ReactMarkdown></div>;
}

export default function AiSkillPanel({ skill, onSaved, onResults }: { skill: Skill; onSaved: (annotation: AiAnnotation) => void; onResults?: (annotations: AiAnnotation[]) => void }) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [results, setResults] = useState<Results>({ translations: [] });
  const preferences = useAiPreferences();
  const language = preferences.targetLanguage;
  const summaryModel = resolveAiModel(preferences.summaryModel, status?.models || []);
  const translationModel = resolveAiModel(preferences.translationModel, status?.models || []);
  const [draft, setDraft] = useState<AiDraft | null>(null);
  const [busy, setBusy] = useState<'summary' | 'translation' | 'save' | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setDraft(null); setError(''); setSaved(false);
    void Promise.all([request<AiStatus>('/ai/status'), request<Results>(`/ai/result?id=${encodeURIComponent(skill.id)}`)])
      .then(([status, results]) => { if (active) { setStatus(status); setResults(results); onResults?.([results.summary, ...results.translations].filter((item): item is AiAnnotation => Boolean(item))); } })
      .catch(error => { if (active) setError(errorMessage(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [skill.id, reload]);

  const generate = async (kind: 'summary' | 'translation') => {
    const current = readAiPreferences();
    if (!current.enabled || busy) return;
    const model = resolveAiModel(kind === 'summary' ? current.summaryModel : current.translationModel, status?.models || []);
    if (!model || !status?.available) { setError('所选模型未在 Magpie 中启用，请刷新并重新选择；不会自动切换到其他模型。'); return; }
    setBusy(kind); setError(''); setSaved(false); setDraft(null);
    try { setDraft(await request<AiDraft>('/ai/generate', 'POST', { skillId: skill.id, kind, model, language: current.targetLanguage, ...(kind === 'summary' ? { summaryContext: current.summaryContext } : {}) })); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const updatePreferences = (patch: Partial<AiPreferences>) => {
    try { saveAiPreferences(patch); } catch (error) { setError(errorMessage(error)); }
  };
  const modelOptions = (preferred: string) => [
    ...(preferred && !status?.models.some(model => model.id === preferred) ? [{ value: preferred, label: `未启用：${preferred}（请重新选择）`, disabled: true }] : []),
    ...(!status?.models.length ? [{ value: '', label: '暂无可用模型', disabled: true }] : []),
    ...(status?.models.map(model => ({ value: model.id, label: model.name || model.id })) || []),
  ];
  const save = async () => {
    if (!draft || busy) return;
    setBusy('save'); setError('');
    try {
      const annotation = await request<AiAnnotation>('/ai/save', 'POST', { draftId: draft.draftId });
      setResults(current => annotation.kind === 'summary' ? { ...current, summary: annotation } : { ...current, translations: [...current.translations.filter(item => item.language !== annotation.language), annotation] });
      setDraft(null); setSaved(true); onSaved(annotation);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(null); }
  };
  const savedAnnotations = [results.summary, ...results.translations].filter((annotation): annotation is AiAnnotation => Boolean(annotation));

  return <section className="ai-skill-panel" data-testid="ai-skill-panel"><div className="ai-panel-heading"><h3><Sparkles size={15} />Magpie AI</h3><span>按需调用 · 显式保存</span></div>
    <p className="ai-disclosure">生成摘要会将此 Skill 的 <strong>{preferences.summaryContext === 'description' ? '原始描述' : 'SKILL.md 正文'}</strong>通过 Magpie 发送给所选模型；翻译仅发送<strong>原始描述</strong>。使用 Magpie 现有提供商与用量规则，不会自动调用，也不会覆盖原始文件。</p>
    {!preferences.enabled && <p className="ai-unavailable" role="status">AI 已停用。已保存的注释仍可查看；请在设置的 AI 行为中启用后再生成。</p>}
    {loading ? <div className="loading-line"><Loader2 size={15} className="spin" />读取 Magpie 可用模型…</div> : <>
      {!status?.available ? <div className="ai-unavailable"><span>{status?.reason || 'Magpie AI 暂不可用。请确认 Magpie 已启动且配置了可用模型。'}</span><button className="text-button" onClick={() => setReload(value => value + 1)}>重新连接</button></div> : <>
        <div className="ai-controls"><label>Skill 总结模型<ShelfSelect aria-label="Magpie AI 模型" value={preferences.summaryModel || summaryModel} onValueChange={value => updatePreferences({ summaryModel: value })} disabled={Boolean(busy)} options={modelOptions(preferences.summaryModel)} /></label><label>描述与翻译模型<ShelfSelect aria-label="AI 描述与翻译模型" value={preferences.translationModel || translationModel} onValueChange={value => updatePreferences({ translationModel: value })} disabled={Boolean(busy)} options={modelOptions(preferences.translationModel)} /></label><label>输出语言<ShelfSelect aria-label="AI 输出语言" value={language} onValueChange={value => updatePreferences({ targetLanguage: value })} disabled={Boolean(busy)} options={aiLanguages.map(([value, label]) => ({ value, label }))} /></label></div>
        {(!summaryModel || !translationModel) && <p className="ai-stale-note">已保存的模型未在 Magpie 中启用；请选择当前可用模型，不会自动切换到其他模型。</p>}
        <div className="ai-generate-actions"><ShelfButton variant="outline" size="sm" onClick={() => void generate('summary')} disabled={!preferences.enabled || !summaryModel || Boolean(busy) || (preferences.summaryContext === 'description' && !skill.description.trim())} data-testid="ai-generate-summary">{busy === 'summary' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}AI 总结</ShelfButton><ShelfButton variant="outline" size="sm" onClick={() => void generate('translation')} disabled={!preferences.enabled || !translationModel || Boolean(busy) || !skill.description.trim()} title={!skill.description.trim() ? '此 Skill 没有可翻译的原始描述' : '只翻译原始描述，不改动原文件'} data-testid="ai-generate-translation">{busy === 'translation' ? <Loader2 size={14} className="spin" /> : <Languages size={14} />}翻译描述</ShelfButton>{!skill.description.trim() && <small>无原始描述可翻译</small>}</div>
        <button className="text-button" disabled={Boolean(busy)} onClick={() => setReload(value => value + 1)}>刷新模型列表</button>
      </>}
    </>}
    {error && <div className="error-banner" role="alert">{error}</div>}
    {draft && <div className="ai-draft" data-testid="ai-draft-preview"><div className="ai-result-heading"><strong>{draft.kind === 'summary' ? '摘要' : '描述翻译'} · 未保存预览</strong><span>{draft.language}</span></div><AnnotationText text={draft.text} /><div className="ai-draft-footer"><small>来源模型：{draft.model}</small><div><button className="text-button" disabled={Boolean(busy)} onClick={() => setDraft(null)}><X size={13} />丢弃</button><ShelfButton variant="default" size="sm" disabled={Boolean(busy)} onClick={() => void save()} data-testid="ai-save-draft">{busy === 'save' ? <Loader2 size={14} className="spin" /> : <Check size={14} />}保存到本地注释</ShelfButton></div></div></div>}
    {saved && <p className="ai-save-notice" role="status"><Check size={13} />已保存到本地注释，原始文件未改动。</p>}
    {savedAnnotations.length > 0 && <div className="ai-saved-results"><div className="ai-saved-label"><ShieldCheck size={13} />已保存的 AI 注释</div>{savedAnnotations.map(annotation => <details key={`${annotation.kind}:${annotation.language}`} open={annotation.language === language}><summary><strong>{annotation.kind === 'summary' ? 'AI 摘要' : 'AI 描述翻译'}</strong><span>{annotation.language}</span>{annotation.stale && <em>源内容已变更</em>}</summary>{annotation.stale && <p className="ai-stale-note">这条注释基于旧内容，已停止用于资料库描述。可手动重新生成并保存。</p>}<AnnotationText text={annotation.text} /><small className="ai-provenance">{annotation.model} · 本地保存于 {new Date(annotation.savedAt || annotation.createdAt).toLocaleString('zh-CN')}</small></details>)}</div>}
  </section>;
}
