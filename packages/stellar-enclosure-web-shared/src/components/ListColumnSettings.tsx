import {ArrowDownOutlined, ArrowUpOutlined} from '@ant-design/icons'
import {Button, Checkbox, Modal, Space} from 'antd'
import {useState, type ReactNode} from 'react'

export interface ListColumnOption {
  readonly key: string
  readonly label: ReactNode
}

export interface ListColumnSelection {
  readonly order: readonly string[]
  readonly selected: readonly string[]
}

export interface ListColumnLabels {
  readonly button?: string
  readonly title?: string
  readonly save?: string
  readonly cancel?: string
  readonly moveUp?: string
  readonly moveDown?: string
}

export interface ListColumnSelectorProps {
  /** Only pass fields the current user may configure. */
  readonly columns: readonly ListColumnOption[]
  readonly value: ListColumnSelection
  readonly onChange: (value: ListColumnSelection) => void
  readonly labels?: ListColumnLabels
  readonly disabled?: boolean
}

/** Controlled field choices and ordering; callers remain responsible for field authorization. */
export function ListColumnSelector({columns, value, onChange, labels, disabled}: ListColumnSelectorProps) {
  const options = new Map(columns.map(column => [column.key, column]))
  const order = [...new Set([...value.order, ...options.keys()])].filter(key => options.has(key))
  const selected = new Set(value.selected.filter(key => options.has(key)))
  const move = (index: number, delta: number) => {
    const next = index + delta
    if (next < 0 || next >= order.length) return
    const reordered = [...order]
    ;[reordered[index], reordered[next]] = [reordered[next], reordered[index]]
    onChange({order: reordered, selected: [...selected]})
  }

  return <Space orientation="vertical" style={{width: '100%'}}>
    {order.map((key, index) => <Space key={key} style={{display: 'flex', justifyContent: 'space-between'}}>
      <Checkbox disabled={disabled} checked={selected.has(key)} onChange={event => {
        const updated = new Set(selected)
        if (event.target.checked) updated.add(key); else updated.delete(key)
        onChange({order, selected: [...updated]})
      }}>{options.get(key)?.label}</Checkbox>
      <Space>
        <Button size="small" aria-label={labels?.moveUp ?? '上移'} icon={<ArrowUpOutlined />}
          disabled={disabled || index === 0} onClick={() => move(index, -1)} />
        <Button size="small" aria-label={labels?.moveDown ?? '下移'} icon={<ArrowDownOutlined />}
          disabled={disabled || index === order.length - 1} onClick={() => move(index, 1)} />
      </Space>
    </Space>)}
  </Space>
}

export interface ListColumnSettingsProps {
  readonly columns: readonly ListColumnOption[]
  /** Visible keys in display order. */
  readonly value: readonly string[]
  readonly onChange: (visibleKeys: string[]) => void
  readonly labels?: ListColumnLabels
  readonly disabled?: boolean
}

/** A page-level editor for visible columns; the caller owns persistence and authorization. */
export function ListColumnSettings({columns, value, onChange, labels, disabled}: ListColumnSettingsProps) {
  const [draft, setDraft] = useState<ListColumnSelection>()
  const available = new Set(columns.map(column => column.key))
  const open = () => {
    const selected = [...new Set(value.filter(key => available.has(key)))]
    setDraft({order: [...selected, ...columns.map(column => column.key).filter(key => !selected.includes(key))], selected})
  }
  return <>
    <Button disabled={disabled} onClick={open}>{labels?.button ?? '配置显示字段'}</Button>
    <Modal open={!!draft} title={labels?.title ?? '配置显示字段'} onCancel={() => setDraft(undefined)} okButtonProps={{disabled}}
      okText={labels?.save ?? '应用'} cancelText={labels?.cancel ?? '取消'} onOk={() => {
        if (!draft) return
        const selected = new Set(draft.selected)
        onChange(draft.order.filter(key => available.has(key) && selected.has(key)))
        setDraft(undefined)
      }}>
      {draft && <ListColumnSelector columns={columns} value={draft} onChange={setDraft} labels={labels} disabled={disabled} />}
    </Modal>
  </>
}
