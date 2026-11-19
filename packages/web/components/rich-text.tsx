'use client'

import { useMemo, useRef, useState } from 'react'
import { ImageLightbox } from '@/components/image-lightbox'
import { collectImages, type LightboxImage } from '@/lib/lightbox'
import { renderRichText, type RenderOptions } from '@/lib/rich-text'

/**
 * Renders issue/comment text (Markdown or Jira wiki markup) as sanitized HTML.
 * The HTML comes from lib/rich-text, which never passes raw HTML through and restricts link/image URLs.
 */
export function RichText({
  value,
  className = '',
  resolveAttachment,
  format,
}: {
  value: string | null | undefined
  className?: string
  resolveAttachment?: RenderOptions['resolveAttachment']
  format?: RenderOptions['format']
}) {
  const html = useMemo(() => renderRichText(value ?? '', { resolveAttachment, format }), [value, resolveAttachment, format])
  const ref = useRef<HTMLDivElement>(null)
  const [viewer, setViewer] = useState<{ images: LightboxImage[]; index: number } | null>(null)
  if (!html) return null
  // a click on a picture in the text opens it in the viewer, together with the other pictures of the same text
  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement
    if (t.tagName !== 'IMG' || e.metaKey || e.ctrlKey || e.shiftKey) return
    const all = Array.from(ref.current?.querySelectorAll('img') ?? [])
    const images = collectImages(all)
    const at = all.indexOf(t as HTMLImageElement)
    const src = (t as HTMLImageElement).currentSrc || (t as HTMLImageElement).src
    const index = images.findIndex((i) => i.src === src)
    if (images.length === 0 || index < 0 || at < 0) return
    e.preventDefault()
    setViewer({ images, index })
  }
  return (
    <>
      <div ref={ref} className={`rich-text ${className}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {viewer && <ImageLightbox images={viewer.images} index={viewer.index} onIndex={(i) => setViewer({ ...viewer, index: i })} onClose={() => setViewer(null)} />}
    </>
  )
}
