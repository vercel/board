import { describe, expect, it, vi } from 'vitest'
import { vercelBlob } from '../src/blob/vercel.ts'

const sdk = vi.hoisted(() => {
  class BlobNotFoundError extends Error {}
  return {
    BlobNotFoundError,
    issueSignedToken: vi.fn(async () => ({ delegationToken: 'dt', clientSigningToken: 'cst', validUntil: 0 })),
    presignUrl: vi.fn(async () => ({ presignedUrl: 'https://vercel.com/api/blob/?pathname=x&vercel-blob-signature=s' })),
    head: vi.fn(async (pathname: string): Promise<{ size: number }> => {
      if (pathname.endsWith('/missing')) throw new BlobNotFoundError()
      return { size: 11 }
    }),
    get: vi.fn(),
    put: vi.fn(),
  }
})
vi.mock('@vercel/blob', () => sdk)

describe('vercelBlob() direct uploads', () => {
  it('presigns a PUT for one pathname under its prefix: put only, at most the size, that type, no overwrite', async () => {
    const blob = vercelBlob({ prefix: 'team_a', storeId: 'store_1' })
    const expiresAt = new Date('2026-10-23T18:30:00Z')
    const signed = await blob.uploadUrl!('vboard/attachments/abc', { contentType: 'video/mp4', maxBytes: 11, expiresAt })
    expect(sdk.issueSignedToken).toHaveBeenCalledWith({
      storeId: 'store_1',
      pathname: 'team_a/vboard/attachments/abc',
      operations: ['put'],
      validUntil: expiresAt.getTime(),
      allowedContentTypes: ['video/mp4'],
      maximumSizeInBytes: 11,
    })
    expect(sdk.presignUrl).toHaveBeenCalledWith(
      { delegationToken: 'dt', clientSigningToken: 'cst', validUntil: 0 },
      expect.objectContaining({ operation: 'put', access: 'private', pathname: 'team_a/vboard/attachments/abc', maximumSizeInBytes: 11, allowOverwrite: false, addRandomSuffix: false }),
    )
    expect(signed).toEqual({
      url: 'https://vercel.com/api/blob/?pathname=x&vercel-blob-signature=s',
      headers: { 'x-api-version': '12', 'x-vercel-blob-access': 'private', 'x-content-type': 'video/mp4' },
    })
  })

  it('reads back the size of what landed, and null when nothing did', async () => {
    const blob = vercelBlob({ prefix: 'team_a' })
    expect(await blob.head!('vboard/attachments/abc')).toEqual({ size: 11 })
    expect(sdk.head).toHaveBeenCalledWith('team_a/vboard/attachments/abc', {})
    expect(await blob.head!('vboard/attachments/missing')).toBeNull()
  })

  it("reads records from origin, so the CDN can't keep a miss for one read before it was written", async () => {
    sdk.get.mockResolvedValue(null)
    const blob = vercelBlob()
    await blob.get('vboard/attachments/abc.json')
    expect(sdk.get).toHaveBeenLastCalledWith('vboard/attachments/abc.json', { access: 'private', useCache: false })
    await blob.get('vboard/attachments/abc')
    expect(sdk.get).toHaveBeenLastCalledWith('vboard/attachments/abc', { access: 'private' })
  })
})
