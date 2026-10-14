/* House Match + roommate compatibility: symmetry, bounds, fair housing. */
const roommates = require('../server/modules/roommates');
const housing = require('../server/modules/housing');
const { ROOMMATES, BLANK_PROFILE, HOUSE } = require('../server/data');

describe('roommate compatibility', () => {
  it('scores every seeded roommate in range', () => {
    ROOMMATES.forEach((r) => {
      const s = roommates.compatibility(BLANK_PROFILE, r);
      assert.ok(s.score >= 0 && s.score <= 98, r.name + ' scored ' + s.score);
    });
  });

  it('is symmetric: score(a,b) === score(b,a)', () => {
    const a = ROOMMATES[0], b = ROOMMATES[1];
    const asProfile = (r) => ({
      budgetMin: r.budget[0], budgetMax: r.budget[1], hood: r.hood, commuteMax: 15,
      clean: r.clean, noise: r.noise, sleep: r.sleep, smoking: r.smoking,
      pets: r.pets, social: r.social, lease: r.lease, moveIn: r.moveIn, beds: 1, furnished: true
    });
    const ab = roommates.compatibility(asProfile(a), b).score;
    const ba = roommates.compatibility(asProfile(b), a).score;
    assert.eq(ab, ba, 'must be order-invariant');
  });

  it('gives a perfect self-match a very high score', () => {
    const r = ROOMMATES[0];
    const self = {
      budgetMin: r.budget[0], budgetMax: r.budget[1], hood: r.hood, commuteMax: 15,
      clean: r.clean, noise: r.noise, sleep: r.sleep, smoking: r.smoking,
      pets: r.pets, social: r.social, lease: r.lease, moveIn: r.moveIn, beds: 1, furnished: true
    };
    assert.ok(roommates.compatibility(self, r).score >= 90);
  });

  it('uses no protected attributes as criteria', () => {
    const forbidden = ['gender', 'age', 'race', 'ethnicity', 'religion', 'national_origin', 'disability', 'familial_status', 'food'];
    roommates.CRITERIA.forEach((c) => {
      assert.ok(forbidden.indexOf(c.key) < 0, 'criterion "' + c.key + '" is a protected attribute');
    });
  });

  it('criterion weights sum to 100', () => {
    assert.eq(roommates.CRITERIA.reduce((n, c) => n + c.w, 0), 100);
  });

  it('explains strengths and mismatches', () => {
    const s = roommates.compatibility(BLANK_PROFILE, ROOMMATES[0]);
    assert.ok(Array.isArray(s.strong) && Array.isArray(s.weak));
  });
});

describe('house match', () => {
  it('scores every housing listing 0-100 with a band', () => {
    Object.keys(HOUSE).forEach((id) => {
      const h = housing.houseScore(BLANK_PROFILE, { id: id });
      assert.ok(h.score >= 0 && h.score <= 100, id + ' -> ' + h.score);
      assert.ok(['High Match', 'Medium Match', 'Low Match'].indexOf(h.band) >= 0);
    });
  });

  it('returns null for non-housing listings', () => {
    assert.eq(housing.houseScore(BLANK_PROFILE, { id: 'electronics-1' }), null);
  });

  it('explains every criterion', () => {
    const h = housing.houseScore(BLANK_PROFILE, { id: 'housing-1' });
    assert.eq(h.rows.length, 7);
    h.rows.forEach((r) => {
      assert.ok(typeof r.ok === 'boolean');
      assert.ok(r.text && r.text.length);
    });
  });

  it('penalises an over-budget home', () => {
    const tight = Object.assign({}, BLANK_PROFILE, { budgetMax: 900 });
    const rich = Object.assign({}, BLANK_PROFILE, { budgetMax: 2600 });
    const id = 'housing-9';   // $2400/mo
    assert.ok(housing.houseScore(tight, { id: id }).score < housing.houseScore(rich, { id: id }).score);
  });

  it('declares its scoring source as heuristic until weights are fitted', () => {
    assert.eq(housing.weightSource().source, 'heuristic');
  });

  it('default weights sum to 100', () => {
    const total = Object.values(housing.DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
    assert.eq(total, 100);
  });
});
