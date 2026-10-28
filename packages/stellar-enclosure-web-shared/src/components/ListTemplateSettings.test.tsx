import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react'
import {QueryClient, QueryClientProvider} from '@tanstack/react-query'
import {useState} from 'react'
import {afterEach, expect, it, vi} from 'vitest'
import {ListTemplateSettings, type ListTemplateView} from './ListTemplateSettings'

const initial: ListTemplateView = {definitionDigest: 'digest', catalogVersion: '1', selectedTemplateId: '1',
  columns: [{columnKey: 'code', labelPage: 'orders', labelKey: 'code'}, {columnKey: 'amount', labelPage: 'orders', labelKey: 'amount'}],
  templates: [{id: '1', type: 'SYSTEM', name: '默认', defaultTemplate: true, version: '1', columnKeys: ['code']},
    {id: '2', type: 'PERSONAL', name: '明细', defaultTemplate: false, version: '1', columnKeys: ['amount', 'code']}],
  visibleColumns: ['code']}

afterEach(cleanup)

it('switches to the server-selected template and renders its returned field order', async () => {
  const select = vi.fn(async (id: string) => {selected = id})
  let selected = '1'
  function Host() {
    const [view, setView] = useState(initial)
    return <><ListTemplateSettings view={view} maySystem={false} mayPersonal={false} selectionWritable
      actions={{select, save: vi.fn(), remove: vi.fn()}}
      refresh={async () => {setView({...initial, selectedTemplateId: selected,
        visibleColumns: selected === '2' ? ['amount', 'code'] : ['code']})}}
      labelColumn={column => column.labelKey} onError={error => {throw error}} />
      <output data-testid="visible">{view.visibleColumns.join(',')}</output></>
  }
  render(<QueryClientProvider client={new QueryClient()}><Host /></QueryClientProvider>)
  fireEvent.mouseDown(screen.getByRole('combobox', {name: '当前字段模板'}))
  fireEvent.click(await screen.findByText('个人模板 · 明细'))
  await waitFor(() => expect(select).toHaveBeenCalledWith('2', initial))
  await waitFor(() => expect(screen.getByTestId('visible')).toHaveTextContent('amount,code'))
})
