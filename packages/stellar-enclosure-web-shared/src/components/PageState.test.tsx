import {render, screen} from '@testing-library/react'
import {describe, expect, it} from 'vitest'
import {ApiError} from '../api/errors'
import {PageState} from './PageState'

describe('PageState', () => {
  it('shows the opaque decision identifier for a denied request', () => {
    const id = '12345678-1234-4234-8234-123456789abc'
    render(<PageState loading={false} empty={false} error={new ApiError('denied', 403, 'AUTHORIZATION_DENIED', {decisionId: id})}>content</PageState>)
    expect(screen.getByText(`决策编号: ${id}`)).toBeInTheDocument()
    expect(screen.queryByText('content')).not.toBeInTheDocument()
  })
})
