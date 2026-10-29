type MessageRecord = Record<string, unknown>
type ReplacementValue = string | number | boolean

const isMessageRecord = (value: unknown): value is MessageRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function useI18nMessages() {
  const { t, tm, rt } = useI18n()

  const toText = (value: unknown): string => {
    if (value == null) return ''
    if (typeof value === 'string') return value
    if (typeof value === 'number' || typeof value === 'boolean') return String(value)
    try {
      return String(rt(value as any))
    } catch {
      return String(value)
    }
  }

  const resolveMessage = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(resolveMessage)
    }
    if (isMessageRecord(value)) {
      const text = toText(value)
      if (text && text !== '[object Object]') return text

      const row: Record<string, unknown> = {}
      for (const [field, fieldValue] of Object.entries(value)) {
        row[field] = resolveMessage(fieldValue)
      }
      return row
    }
    return toText(value)
  }

  const messageList = (key: string, replacements?: Record<string, ReplacementValue>): string[] => {
    const value = tm(key)
    if (!Array.isArray(value)) return []
    return value.map((item, index) => {
      const messageKey = `${key}.${index}`
      const translated = replacements ? t(messageKey, replacements) : t(messageKey)
      return translated === messageKey ? toText(item) : translated
    })
  }

  const messageObjectList = <T extends object = Record<string, string>>(key: string): T[] => {
    const value = tm(key)
    if (!Array.isArray(value)) return []

    return value.map((item) => {
      if (!isMessageRecord(item)) return {} as T

      const row: Record<string, unknown> = {}
      for (const [field, fieldValue] of Object.entries(item)) {
        row[field] = resolveMessage(fieldValue)
      }
      return row as T
    })
  }

  return {
    messageList,
    messageObjectList,
    resolveMessage,
    toText
  }
}
