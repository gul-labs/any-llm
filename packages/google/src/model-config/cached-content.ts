import { z } from 'zod'

/**
 * `providerOptions.google.cachedContent` for the models that cache explicitly:
 * the cache's resource name, or `{ cacheName, toolKinds }` taken from a
 * `GoogleCacheHandle` (`toolKinds` records which tools the cache holds, so a
 * cached `googleSearch` is priced as Search). The request sent to Google
 * carries only the name. Like every config object it is strict: a whole handle
 * (with `expiresAt`, `model`) is rejected, and the type refuses it too.
 */
export const cachedContentSchema = z
  .union([
    z.string().min(1),
    z.strictObject({
      cacheName: z.string().min(1).meta({
        title: 'Cache Name',
        description: 'Google cached content resource name.',
      }),
      toolKinds: z.array(z.string().min(1)).optional().meta({
        title: 'Tool Kinds',
        description:
          'The tool kinds the cache holds (`GoogleCacheHandle.toolKinds`), e.g. googleSearch.',
      }),
    }),
  ])
  .optional()
  .meta({
    title: 'Cached Content',
    description:
      'Google cached content: the resource name, or { cacheName, toolKinds } from a cache handle.',
  })
