import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const locations = JSON.parse(readFileSync(new URL('../public/data/locations.json', import.meta.url), 'utf8'))
const vite = await createServer({ root: fileURLToPath(new URL('../', import.meta.url)), configFile: false, envDir: false,
  optimizeDeps: { noDiscovery: true, entries: [] },
  define: { 'import.meta.env.VITE_API_BASE': JSON.stringify('https://api.invalid') },
  server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
const originalFetch = globalThis.fetch
try {
  let requests = 0
  globalThis.fetch = async () => { requests++; throw new Error('Chat must remain offline') }
  const { classifyEnglish } = await vite.ssrLoadModule('/src/copilot/englishConversation.js')
  const { runTurn } = await vite.ssrLoadModule('/src/copilot/copilotEngine.js')
  const deps = { locations, position: null }
  const english = text => classifyEnglish(text, locations)
  for (const text of ['Thanks!', 'Thank you so much', 'How are you?', 'Hello there', 'No thanks', 'That helps', 'Appreciate your help']) {
    assert.equal(english(text).intent, 'greeting', text)
  }
  for (const text of ['Can I use this without internet?', 'Will this app work offline?', 'Can I get directions without internet?', 'How can I navigate without internet?']) {
    assert.equal(english(text).intent, 'faq', text)
    assert.match(english(text).reply, /Open the app once with internet/)
  }
  for (const text of ['What time does the library close?', 'Is the canteen open?', 'When does CSE Block open?', 'What are the library opening hours?']) {
    assert.equal(english(text).intent, 'faq', text)
    assert.match(english(text).reply, /do not have verified opening hours/)
  }
  for (const [text, id] of [['Where is CSE?', 'cse-block'], ['Can you help me find the library?', 'central-library'],
    ['Take me to Main Auditorium', 'tcs-auditorium'], ['Where is ECE?', 'ece-block'], ['Where is the IT block?', 'it-block']]) {
    assert.deepEqual(english(text).resolved_locations.map(l => l.id), [id], text)
  }
  assert.equal(english('Where is the sports complex?').resolved_locations.length, 2, 'Genuine shared names must remain ambiguous')
  assert.equal(english('ECE302').intent, 'classroom_finder')
  assert.equal(english('Show me upcoming events').intent, 'event_upcoming')
  assert.equal(english('Where can I get drinking water?').need_type, 'water_station')
  assert.equal(english('What is the weather in Chennai?').intent, 'out_of_scope')

  const selection = await runTurn('Where is CSE?', {}, deps)
  assert.deepEqual(selection.cards.map(c => c.id), ['cse-block'])
  let state = selection.newState
  for (const text of ['Thanks!', 'How are you?', 'Can I use this without internet?', 'Tell me more about it']) {
    const response = await runTurn(text, state, deps)
    assert.equal(response.newState.lastLocationId, 'cse-block', text)
    state = response.newState
  }
  assert.deepEqual((await runTurn('Show route preview', state, deps)).action, { type: 'preview_route', locationId: 'cse-block' })
  for (const text of ['I do not want to cancel navigation', "Don't stop navigation", 'Don’t cancel navigation',
    'Never start navigation', 'Do not navigate there', 'Do not take me to CSE', 'How do I cancel navigation?',
    'What does stop navigation mean?', 'Cancel the event registration',
    'Will saying stop navigation cancel it?', 'Why should I cancel navigation?', 'If I say navigate there what happens?']) {
    const response = await runTurn(text, state, deps)
    assert.equal(response.action, null, text)
    assert.equal(response.newState.lastLocationId, 'cse-block', text)
  }
  assert.equal((await runTurn('Please cancel navigation', state, deps)).action.type, 'cancel_navigation')
  assert.equal((await runTurn('Take me there', state, deps)).action.locationId, 'cse-block')
  assert.equal((await runTurn('Thanks, can you navigate there?', state, deps)).action.type, 'start_navigation', 'Greeting prefix must not swallow a real request')
  assert.equal((await runTurn('Where is it?', {}, deps)).action, null)
  assert.match((await runTurn('Where is it?', {}, deps)).replyText, /Which campus place/)
  assert.equal(requests, 0)
  console.log('PASS: English greetings/thanks, natural FAQs, precise place matches, genuine ambiguity, room/event/facility intents, context across small talk, negation/instruction guards, explicit actions; zero network requests.')
} finally { globalThis.fetch = originalFetch; await vite.close() }
