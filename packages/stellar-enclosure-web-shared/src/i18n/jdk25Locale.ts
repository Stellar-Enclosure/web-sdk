/** RC uses JDK 25 Locale.Builder, whose aliases and variant rules differ from ICU/Intl. */
const legacy = new Map(Object.entries({
  'art-lojban': 'jbo', 'cel-gaulish': 'xtg-x-cel-gaulish', 'en-gb-oed': 'en-GB-x-oed',
  'i-ami': 'ami', 'i-bnn': 'bnn', 'i-default': 'en-x-i-default', 'i-enochian': 'und-x-i-enochian',
  'i-hak': 'hak', 'i-klingon': 'tlh', 'i-lux': 'lb', 'i-mingo': 'see-x-i-mingo', 'i-navajo': 'nv',
  'i-pwn': 'pwn', 'i-tao': 'tao', 'i-tay': 'tay', 'i-tsu': 'tsu', 'no-bok': 'nb', 'no-nyn': 'nn',
  'sgn-be-fr': 'sfb', 'sgn-be-nl': 'vgt', 'sgn-ch-de': 'sgg', 'zh-guoyu': 'cmn', 'zh-hakka': 'hak',
  'zh-min': 'nan-x-zh-min', 'zh-min-nan': 'nan', 'zh-xiang': 'hsn',
}))
const variant = (value?: string): boolean => /^(?:[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3})$/.test(value ?? '')
const unicodeExtension = (tokens: readonly string[]): string[] => {
  const attributes = new Set<string>()
  const keywords = new Map<string, string[]>()
  let index = 0
  while (index < tokens.length && tokens[index].length >= 3) attributes.add(tokens[index++].toLowerCase())
  while (index < tokens.length) {
    const key = tokens[index++].toLowerCase()
    const type: string[] = []
    while (index < tokens.length && tokens[index].length >= 3) type.push(tokens[index++].toLowerCase())
    if (!keywords.has(key)) keywords.set(key, type)
  }
  return [...attributes].sort().concat([...keywords.keys()].sort().flatMap(key => [key, ...keywords.get(key)!]))
}

const parseLocale = (input: unknown): { canonical: string; language: string } | null => {
  if (typeof input !== 'string' || !input || input.includes('_')) return null
  const tokens = (legacy.get(input.toLowerCase()) ?? input).split('-')
  let index = 0
  let language = ''
  let script = ''
  let region = ''
  let variants: string[] = []
  const extensions = new Map<string, string[]>()
  let privateUse: string[] = []
  if (/^[A-Za-z]{2,8}$/.test(tokens[index])) {
    const rawLanguage = tokens[index++]
    language = rawLanguage === 'und' ? '' : rawLanguage.toLowerCase()
    const extended: string[] = []
    while (extended.length < 3 && /^[A-Za-z]{3}$/.test(tokens[index] ?? '')) extended.push(tokens[index++])
    if (extended.length) language = extended[0].toLowerCase()
    const aliases: Readonly<Record<string, string>> = { iw: 'he', ji: 'yi', in: 'id' }
    language = aliases[language] ?? language
    if (/^[A-Za-z]{4}$/.test(tokens[index] ?? '')) {
      const value = tokens[index++]; script = value[0].toUpperCase() + value.slice(1).toLowerCase()
    }
    if (/^(?:[A-Za-z]{2}|[0-9]{3})$/.test(tokens[index] ?? '')) region = tokens[index++].toUpperCase()
    while (variant(tokens[index])) variants.push(tokens[index++])
    // JDK 25 accepts alphabetic extension singletons; it does not accept numeric ones.
    while (/^[A-WY-Za-wy-z]$/.test(tokens[index] ?? '')) {
      const key = tokens[index++].toLowerCase()
      const values: string[] = []
      while (/^[A-Za-z0-9]{2,8}$/.test(tokens[index] ?? '')) values.push(tokens[index++])
      if (!values.length) return null
      if (!extensions.has(key)) extensions.set(key, key === 'u' ? unicodeExtension(values) : values.map(value => value.toLowerCase()))
    }
  }
  if (/^[xX]$/.test(tokens[index] ?? '')) {
    index += 1
    while (/^[A-Za-z0-9]{1,8}$/.test(tokens[index] ?? '')) privateUse.push(tokens[index++])
    if (!privateUse.length) return null
  }
  if (index !== tokens.length) return null
  const legacyVariant = privateUse.findIndex((value, position) => value.toLowerCase() === 'lvariant' && position < privateUse.length - 1)
  if (legacyVariant >= 0) {
    variants.push(...privateUse.slice(legacyVariant + 1))
    privateUse = privateUse.slice(0, legacyVariant)
  }
  privateUse = privateUse.map(value => value.toLowerCase())
  if (!script && !extensions.size && !privateUse.length) {
    if (language === 'ja' && region === 'JP' && variants.join('_') === 'JP') extensions.set('u', ['ca', 'japanese'])
    if (language === 'th' && region === 'TH' && variants.join('_') === 'TH') extensions.set('u', ['nu', 'thai'])
  }
  if (language === 'no' && region === 'NO' && variants.join('_') === 'NY') { language = 'nn'; variants = [] }
  const ordinaryVariants: string[] = []
  let position = 0
  while (position < variants.length && variant(variants[position])) ordinaryVariants.push(variants[position++])
  if (position < variants.length) privateUse.push('lvariant', ...variants.slice(position))
  const normal = [script, region].filter(Boolean).concat(ordinaryVariants,
    [...extensions.keys()].sort().flatMap(key => [key, ...extensions.get(key)!]))
  const tag = (language ? [language] : normal.length || !privateUse.length ? ['und'] : []).concat(normal)
  if (privateUse.length) tag.push('x', ...privateUse)
  return { canonical: tag.join('-'), language }
}

export const canonicalJdk25Locale = (value: unknown): string | null => parseLocale(value)?.canonical ?? null
export const isCanonicalJdk25Locale = (value: unknown): value is string => {
  if (typeof value !== 'string' || !value.length || value.length > 64) return false
  const parsed = parseLocale(value)
  return parsed !== null && parsed.language !== '' && parsed.language !== 'und' && parsed.canonical === value
}
