#!/usr/bin/env node
// test-tc-parsing.js — Manual review script for Claude API T&C and bonus parsing
// Phase 5: Tests 5 cases and prints PASS/FAIL for each.
// Usage: ANTHROPIC_API_KEY=<key> node bridge/test-tc-parsing.js

const { parseTAndC, parseBonus } = require('./tc-parser');

let passed = 0;
let total = 5;

async function runCase(caseNum, description, fn) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Case ${caseNum}: ${description}`);
  console.log('='.repeat(70));
  try {
    const result = await fn();
    if (result) {
      passed++;
      console.log(`\n>>> VERDICT: PASS <<<`);
    } else {
      console.log(`\n>>> VERDICT: FAIL <<<`);
    }
  } catch (err) {
    console.log(`\n>>> VERDICT: FAIL (exception: ${err.message}) <<<`);
  }
}

async function main() {
  console.log('MileagePlus Deal Finder — Phase 5 T&C Parsing Manual Review');
  console.log(`API Key set: ${process.env.ANTHROPIC_API_KEY ? 'yes' : 'NO (tests will fail)'}`);
  console.log(`Timestamp: ${new Date().toISOString()}`);

  // Case 1: BestBuy explicit inclusions and exclusions
  await runCase(1, 'Explicit inclusions and exclusions (BestBuy)', async () => {
    const rawText = 'Earn miles on electronics, computers, tablets, and appliances purchased at BestBuy.com. Gift cards, services, warranties, and delivery fees are not eligible for mile earning. Miles are earned on the purchase price excluding taxes and shipping.';
    const result = await parseTAndC(rawText, 'BestBuy');
    console.log('Parsed result:', JSON.stringify(result, null, 2));

    const incLower = result.inclusions.map(s => s.toLowerCase());
    const excLower = result.exclusions.map(s => s.toLowerCase());
    const hasElectronics = incLower.some(s => s.includes('electronic'));
    const hasComputers = incLower.some(s => s.includes('computer'));
    const hasTablets = incLower.some(s => s.includes('tablet'));
    const hasAppliances = incLower.some(s => s.includes('appliance'));
    const hasGiftCards = excLower.some(s => s.includes('gift card') || s.includes('gift cards'));
    const hasConfidence = result.confidence >= 0.7;

    console.log(`  Inclusions contain electronics-related: ${hasElectronics || hasComputers || hasTablets || hasAppliances}`);
    console.log(`  Exclusions contain Gift Cards: ${hasGiftCards}`);
    console.log(`  Confidence >= 0.7: ${hasConfidence} (${result.confidence})`);

    return (hasElectronics || hasComputers || hasTablets || hasAppliances) && hasGiftCards && hasConfidence;
  });

  // Case 2: Vague scope (Target)
  await runCase(2, 'Vague scope with minimal exclusions (Target)', async () => {
    const rawText = 'Earn miles on all purchases at Target.com excluding alcohol and pharmacy.';
    const result = await parseTAndC(rawText, 'Target');
    console.log('Parsed result:', JSON.stringify(result, null, 2));

    const incLower = result.inclusions.map(s => s.toLowerCase());
    const excLower = result.exclusions.map(s => s.toLowerCase());
    const hasSpecificInclusions = incLower.length === 0 || incLower.every(s =>
      s.includes('all') || s.includes('general') || s.includes('most') || s.includes('purchase'));
    const hasAlcohol = excLower.some(s => s.includes('alcohol'));
    const hasPharmacy = excLower.some(s => s.includes('pharmacy'));
    const noGiftCards = !excLower.some(s => s.includes('gift card') || s.includes('gift cards'));
    const lowConfidence = result.confidence < 0.6;

    console.log(`  No specific category inclusions: ${hasSpecificInclusions}`);
    console.log(`  Exclusions contain Alcohol: ${hasAlcohol}`);
    console.log(`  Exclusions contain Pharmacy: ${hasPharmacy}`);
    console.log(`  Gift Cards NOT in exclusions: ${noGiftCards}`);
    console.log(`  Confidence < 0.6: ${lowConfidence} (${result.confidence})`);

    return hasSpecificInclusions && hasAlcohol && hasPharmacy && noGiftCards && lowConfidence;
  });

  // Case 3: Total rate multiplier (Dell 5x)
  await runCase(3, 'Total rate multiplier — 5x language (Dell)', async () => {
    const rawText = 'Shop at Dell.com and earn 5x miles.';
    const result = await parseBonus(rawText, 'Dell', 1.0);
    console.log('Parsed result:', JSON.stringify(result, null, 2));

    const typeMatch = result.bonus_type === 'rate_multiplier';
    const semanticsMatch = result.config?.semantics === 'total';
    const rateMatch = result.config?.rate === 5.0;

    console.log(`  bonus_type = rate_multiplier: ${typeMatch}`);
    console.log(`  semantics = total: ${semanticsMatch}`);
    console.log(`  rate = 5.0: ${rateMatch} (${result.config?.rate})`);

    return typeMatch && semanticsMatch && rateMatch;
  });

  // Case 4: Incremental bonus language (HP)
  await runCase(4, 'Incremental bonus language (HP)', async () => {
    const rawText = 'Earn an extra 3 miles per dollar on qualifying purchases.';
    const result = await parseBonus(rawText, 'HP', 2.0);
    console.log('Parsed result:', JSON.stringify(result, null, 2));

    const typeMatch = result.bonus_type === 'rate_multiplier';
    const semanticsMatch = result.config?.semantics === 'incremental';
    const rateMatch = result.config?.rate === 3.0;

    console.log(`  bonus_type = rate_multiplier: ${typeMatch}`);
    console.log(`  semantics = incremental: ${semanticsMatch}`);
    console.log(`  rate = 3.0: ${rateMatch} (${result.config?.rate})`);

    return typeMatch && semanticsMatch && rateMatch;
  });

  // Case 5: Flat tiered with new_customer restriction (Lenovo)
  await runCase(5, 'Flat tiered bonus with new_customer restriction (Lenovo)', async () => {
    const rawText = 'New members only: earn 1,000 bonus miles on your first purchase of $50 or more.';
    const result = await parseBonus(rawText, 'Lenovo', 1.5);
    console.log('Parsed result:', JSON.stringify(result, null, 2));

    const typeMatch = result.bonus_type === 'flat_tiered';
    const tiers = result.config?.tiers || [];
    const hasTier = tiers.some(t => {
      const threshold = Array.isArray(t) ? t[0] : t.threshold || t[0];
      const miles = Array.isArray(t) ? t[1] : t.miles || t[1];
      return threshold === 50.0 && miles === 1000.0;
    });
    const newCustomer = result.config?.new_customer_only === true;
    const oncePer = result.config?.once_per_member === true;

    console.log(`  bonus_type = flat_tiered: ${typeMatch}`);
    console.log(`  tiers contain [50, 1000]: ${hasTier}`);
    console.log(`  new_customer_only = true: ${newCustomer}`);
    console.log(`  once_per_member = true: ${oncePer}`);

    return typeMatch && hasTier && newCustomer && oncePer;
  });

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUMMARY: ${passed}/${total} cases passed.`);
  console.log('='.repeat(70));

  process.exit(passed >= 4 ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
