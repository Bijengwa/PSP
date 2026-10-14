import { useEffect } from 'react'

export const SITE = 'PSP Engineering Group'

// Sets the tab title ("<title> | PSP Engineering Group", or the site name alone)
// and <meta name="description"> while the page is shown; puts them back after.
export default function PageMeta({ title, description }: { title: string; description: string }) {
  const full = title ? `${title} | ${SITE}` : SITE

  useEffect(() => {
    const previousTitle = document.title
    let meta = document.head.querySelector<HTMLMetaElement>('meta[name="description"]')
    const created = !meta
    if (!meta) {
      meta = document.createElement('meta')
      meta.name = 'description'
      document.head.append(meta)
    }
    const previousContent = meta.content
    document.title = full
    meta.content = description
    // Put back only what is still ours: when one page's state replaces another,
    // the next PageMeta may already have set its own.
    return () => {
      if (document.title === full) document.title = previousTitle
      if (meta.content !== description) return
      if (created) meta.remove()
      else meta.content = previousContent
    }
  }, [full, description])

  return null
}
