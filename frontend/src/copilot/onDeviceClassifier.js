import { classifyEnglish } from './englishConversation'
import { getIntentModelStatus, predictWithIntentModel } from './intentModelClient'
import { modelSuggestedQueries } from './modelSuggestions'

export async function classifyOnDevice(message, locations, state = {}) {
  const result = classifyEnglish(message, locations, state)
  const warmed = getIntentModelStatus().state === 'ready'
  const inference = predictWithIntentModel(message).catch(() => null)
  // Never hold a first response behind a model download. Known rules, FAQs
  // and explicit commands keep their behaviour. Negated/guarded requests are
  // not candidates for model reinterpretation.
  if (warmed && ['unknown', 'out_of_scope'].includes(result.intent) && !result.preserve_context) {
    const prediction = await inference
    const suggestions = modelSuggestedQueries(prediction, state, message)
    if (suggestions.length) return { ...result,
      reply: "I'm not certain I understood. Did you mean one of these? Tap a question to confirm, or rephrase your request.",
      suggested_queries: suggestions, preserve_context: true }
  }
  return result
}
