/* Event logging: validation, normalisation, PII scrubbing, batching. */
const events = require('../server/lib/events');

describe('event logging', () => {
  it('accepts a valid impression', () => {
    const errs = events.validateEvent({ event_type: 'impression', surface: 'foryou', rank_position: 0 });
    assert.eq(errs, null);
  });

  it('rejects an event with no type', () => {
    const errs = events.validateEvent({ surface: 'foryou' });
    assert.ok(errs && errs.length, 'should report errors');
  });

  it('rejects an unknown surface', () => {
    const errs = events.validateEvent({ event_type: 'click', surface: 'not_a_surface' });
    assert.ok(errs && errs[0].indexOf('surface') >= 0);
  });

  it('rejects a non-numeric rank_position', () => {
    const errs = events.validateEvent({ event_type: 'impression', rank_position: 'first' });
    assert.ok(errs && errs.length);
  });

  it('accepts an unknown event type but flags it', () => {
    const ev = events.normalise({ event_type: 'brand_new_signal' }, {});
    assert.eq(ev.known_type, false);
    assert.eq(ev.event_type, 'brand_new_signal');
  });

  it('never stores PII from metadata', () => {
    const ev = events.normalise({
      event_type: 'click',
      metadata: { email: 'ttrojan@usc.edu', token: 'secret', message_text: 'hi', category: 'housing' }
    }, {});
    assert.eq(ev.metadata.email, undefined, 'email must be dropped');
    assert.eq(ev.metadata.token, undefined, 'token must be dropped');
    assert.eq(ev.metadata.message_text, undefined, 'message body must be dropped');
    assert.eq(ev.metadata.category, 'housing', 'safe fields survive');
  });

  it('pseudonymises the user id and is stable', () => {
    const a = events.pseudonymise('ttrojan@usc.edu');
    const b = events.pseudonymise('ttrojan@usc.edu');
    assert.eq(a, b, 'stable across calls');
    assert.ok(a.indexOf('usc.edu') < 0, 'must not contain the email');
    assert.ok(a.startsWith('u_'));
  });

  it('rejects a future timestamp by clamping to now', () => {
    const future = Date.now() + 86400000;
    const ev = events.normalise({ event_type: 'click', timestamp: future }, {});
    assert.ok(ev.timestamp < future, 'implausible future timestamp replaced');
  });

  it('carries recommendation provenance fields', () => {
    const ev = events.normalise({
      event_type: 'impression', recommendation_source: 'ml_ranker',
      model_version: 'lgbm_v1', experiment_id: 'exp_1', variant: 'treatment', propensity: 0.05
    }, {});
    assert.eq(ev.recommendation_source, 'ml_ranker');
    assert.eq(ev.model_version, 'lgbm_v1');
    assert.eq(ev.variant, 'treatment');
    assert.eq(ev.propensity, 0.05);
  });

  it('ingests a mixed batch, accepting good and reporting bad', () => {
    const out = events.ingest([
      { event_type: 'impression', listing_id: 'housing-1', surface: 'foryou', rank_position: 0 },
      { surface: 'foryou' },
      { event_type: 'save', listing_id: 'housing-1' }
    ], { userId: 'u_test' });
    assert.eq(out.accepted, 2);
    assert.eq(out.rejected.length, 1);
  });
});
