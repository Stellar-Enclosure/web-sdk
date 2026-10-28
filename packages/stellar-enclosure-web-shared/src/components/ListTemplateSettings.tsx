import {useMutation} from '@tanstack/react-query'
import {Alert, Button, Input, Modal, Popconfirm, Select, Space, Switch, Typography} from 'antd'
import {useState, type ReactNode} from 'react'
import {ListColumnSelector, type ListColumnLabels} from './ListColumnSettings'

export interface ListTemplateColumn { readonly columnKey: string; readonly labelPage: string; readonly labelKey: string }
export interface ListTemplate {
  readonly id: string
  readonly type: 'SYSTEM' | 'PERSONAL'
  readonly name: string
  readonly defaultTemplate: boolean
  readonly version: string
  readonly columnKeys: readonly string[]
}
export interface ListTemplateView {
  readonly definitionDigest: string
  readonly catalogVersion: string
  readonly columns: readonly ListTemplateColumn[]
  readonly templates: readonly ListTemplate[]
  readonly selectedTemplateId: string | null
  readonly visibleColumns: readonly string[]
  readonly mayManageSystem?: boolean
  readonly mayManagePersonal?: boolean
}
export interface ListTemplateSave {
  readonly id?: string
  readonly expectedVersion?: string
  readonly name: string
  readonly columnKeys: string[]
  readonly defaultTemplate: boolean
  readonly catalogVersion: string
  readonly definitionDigest: string
}
export interface ListTemplateActions {
  readonly save: (type: ListTemplate['type'], command: ListTemplateSave) => Promise<ListTemplate>
  readonly select: (id: string, view: ListTemplateView) => Promise<unknown>
  readonly remove: (template: ListTemplate, catalogVersion: string) => Promise<unknown>
}
export interface ListTemplateLabels extends ListColumnLabels {
  readonly selected?: string
  readonly defaultView?: string
  readonly system?: string
  readonly personal?: string
  readonly newSystem?: string
  readonly newPersonal?: string
  readonly edit?: string
  readonly name?: string
  readonly setDefault?: string
  readonly delete?: string
  readonly deleteConfirm?: string
  readonly unavailable?: (count: number) => string
}
export interface ListTemplateSettingsProps {
  readonly view: ListTemplateView
  readonly managementView?: ListTemplateView
  readonly maySystem: boolean
  readonly mayPersonal: boolean
  readonly selectionWritable: boolean
  readonly actions: ListTemplateActions
  readonly refresh: () => Promise<unknown>
  readonly labelColumn: (column: ListTemplateColumn) => ReactNode
  readonly onError: (error: unknown) => void
  readonly onNotice?: (notice: 'saved' | 'savedApplyFailed' | 'deleted') => void
  readonly labels?: ListTemplateLabels
  readonly renderExtra?: (busy: boolean) => ReactNode
}
type Draft = {type: ListTemplate['type']; template?: ListTemplate; name: string; defaultTemplate: boolean; order: string[]; selected: string[]; unavailable: number}

/** Template state is supplied by the authenticated host; this component never decides field permissions. */
export function ListTemplateSettings({view, managementView, maySystem, mayPersonal, selectionWritable, actions, refresh,
  labelColumn, onError, onNotice, labels, renderExtra}: ListTemplateSettingsProps) {
  const [draft, setDraft] = useState<Draft>()
  const select = useMutation({mutationFn: (id: string) => actions.select(id, view), onSuccess: refresh, onError})
  const save = useMutation({mutationFn: (value: Draft) => actions.save(value.type, {
    id: value.template?.id, expectedVersion: value.template?.version, name: value.name,
    columnKeys: value.order.filter(key => value.selected.includes(key)), defaultTemplate: value.defaultTemplate,
    catalogVersion: view.catalogVersion, definitionDigest: view.definitionDigest,
  }), onSuccess: async saved => {
    setDraft(undefined)
    let applyFailed = false
    try { if (selectionWritable) await actions.select(saved.id, view) } catch { applyFailed = true }
    await refresh()
    onNotice?.(applyFailed ? 'savedApplyFailed' : 'saved')
  }, onError})
  const remove = useMutation({mutationFn: (template: ListTemplate) => actions.remove(template, view.catalogVersion),
    onSuccess: async () => {setDraft(undefined); await refresh(); onNotice?.('deleted')}, onError})
  const selected = view.templates.find(template => template.id === view.selectedTemplateId)
  const edit = (type: ListTemplate['type'], template?: ListTemplate) => {
    const source = type === 'SYSTEM' ? managementView : view
    if (!source) return
    const saved = template && source.templates.find(item => item.id === template.id)
    const available = source.columns.map(column => column.columnKey)
    const chosen = (saved?.columnKeys ?? view.visibleColumns).filter(key => available.includes(key))
    setDraft({type, template: saved, name: saved?.name ?? '', defaultTemplate: saved?.defaultTemplate ?? false,
      order: [...chosen, ...available.filter(key => !chosen.includes(key))], selected: chosen,
      unavailable: type === 'SYSTEM' ? (saved?.columnKeys.filter(key => !available.includes(key)).length ?? 0) : 0})
  }
  const draftColumns = draft?.type === 'SYSTEM' ? managementView?.columns ?? [] : view.columns
  const busy = select.isPending || save.isPending || remove.isPending
  return <>
    <Space wrap>
      <Select aria-label={labels?.selected ?? '当前字段模板'} style={{minWidth: 200}} value={view.selectedTemplateId ?? undefined}
        placeholder={labels?.defaultView ?? '默认视图'} loading={select.isPending}
        disabled={!selectionWritable || busy || view.templates.length === 0}
        options={view.templates.map(template => ({value: template.id,
          label: `${template.type === 'SYSTEM' ? labels?.system ?? '系统模板' : labels?.personal ?? '个人模板'} · ${template.name}`}))}
        onChange={id => select.mutate(id)} />
      {mayPersonal && <Button disabled={busy} onClick={() => edit('PERSONAL')}>{labels?.newPersonal ?? '新建个人模板'}</Button>}
      {maySystem && <Button disabled={busy || !managementView} onClick={() => edit('SYSTEM')}>{labels?.newSystem ?? '新建系统模板'}</Button>}
      {selected && (selected.type === 'SYSTEM' ? maySystem : mayPersonal) &&
        <Button disabled={busy || selected.type === 'SYSTEM' && !managementView} onClick={() => edit(selected.type, selected)}>{labels?.edit ?? '编辑模板'}</Button>}
      {renderExtra?.(busy)}
    </Space>
    <Modal open={!!draft} title={draft?.type === 'SYSTEM' ? labels?.system ?? '系统模板' : labels?.personal ?? '个人模板'}
      onCancel={() => setDraft(undefined)} onOk={() => {if (draft) save.mutate(draft)}}
      okText={labels?.save ?? '保存'} cancelText={labels?.cancel ?? '取消'} confirmLoading={save.isPending} okButtonProps={{disabled: !draft?.name.trim()}}
      footer={(_, {OkBtn, CancelBtn}) => <Space>
        {draft?.template && <Popconfirm title={labels?.deleteConfirm ?? '确认删除此模板？'} onConfirm={() => remove.mutate(draft.template!)}>
          <Button danger loading={remove.isPending}>{labels?.delete ?? '删除'}</Button></Popconfirm>}
        <CancelBtn /><OkBtn />
      </Space>}>
      {draft && <Space orientation="vertical" style={{width: '100%'}}>
        {draft.unavailable > 0 && <Alert type="warning" title={labels?.unavailable?.(draft.unavailable) ?? `${draft.unavailable} 个字段已不在当前列表定义中，保存后将移除。`} />}
        <Input aria-label={labels?.name ?? '模板名称'} value={draft.name} maxLength={128}
          onChange={event => setDraft({...draft, name: event.target.value})} />
        <Space><Switch aria-label={labels?.setDefault ?? '设为默认'} checked={draft.defaultTemplate}
          onChange={value => setDraft({...draft, defaultTemplate: value})} /><Typography.Text>{labels?.setDefault ?? '设为默认'}</Typography.Text></Space>
        <ListColumnSelector columns={draftColumns.map(column => ({key: column.columnKey, label: labelColumn(column)}))}
          value={{order: draft.order, selected: draft.selected}}
          onChange={value => setDraft({...draft, order: [...value.order], selected: [...value.selected]})} labels={labels} />
      </Space>}
    </Modal>
  </>
}
