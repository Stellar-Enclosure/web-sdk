import {cleanup, fireEvent, render, screen, within} from '@testing-library/react'
import {afterEach, expect, it, vi} from 'vitest'
import {ListColumnSettings} from './ListColumnSettings'

const columns = [{key: 'code', label: '编号'}, {key: 'name', label: '名称'}, {key: 'description', label: '描述'}]
afterEach(cleanup)

it('applies checked columns in the chosen order and discards a cancelled draft', async () => {
  const change = vi.fn()
  render(<ListColumnSettings columns={columns} value={['code', 'name']} onChange={change} />)
  fireEvent.click(screen.getByRole('button', {name: '配置显示字段'}))
  let dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('checkbox', {name: '描述'}))
  const up = within(dialog).getAllByRole('button', {name: '上移'})
  fireEvent.click(up[2])
  fireEvent.click(within(dialog).getByRole('button', {name: /应\s*用/}))
  expect(change).toHaveBeenCalledWith(['code', 'description', 'name'])
  fireEvent.click(screen.getByRole('button', {name: '配置显示字段'}))
  dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('checkbox', {name: '编号'}))
  fireEvent.click(within(dialog).getByRole('button', {name: /取\s*消/}))
  expect(change).toHaveBeenCalledTimes(1)
})

it('cannot apply a column that is no longer available while the editor is open', async () => {
  const change = vi.fn()
  const props = {value: ['code', 'name'], onChange: change}
  const {rerender} = render(<ListColumnSettings {...props} columns={columns} />)
  fireEvent.click(screen.getByRole('button', {name: '配置显示字段'}))
  const dialog = await screen.findByRole('dialog')
  rerender(<ListColumnSettings {...props} columns={[columns[0]]} />)
  expect(within(dialog).queryByRole('checkbox', {name: '名称'})).not.toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', {name: /应\s*用/}))
  expect(change).toHaveBeenCalledWith(['code'])
})
