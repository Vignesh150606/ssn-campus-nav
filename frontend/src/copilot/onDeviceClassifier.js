import { classifyEnglish } from './englishConversation'
import { predictWithIntentModel } from './intentModelClient'

export function classifyOnDevice(message, locations, state) {
  const result = classifyEnglish(message, locations, state)
  // The supplied four-label model has rejection/production approval disabled.
  // Exercise it locally for phone QA, while preserving every existing intent,
  // entity check, FAQ and action. Promotion requires a separately reviewed model.
  void predictWithIntentModel(message).catch(() => {})
  return result
}
