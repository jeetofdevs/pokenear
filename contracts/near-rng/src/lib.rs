//! Pokenear RNG: one on-chain random draw per card rip.
//!
//! Flow: the Pokenear server issues a one-time 32-byte `seed` for a rip; the player calls
//! `draw(seed)` from their own NEAR account (attaching a small storage deposit). The contract
//! mixes NEAR's protocol randomness (`env::random_seed()`) with the seed, the caller and the
//! block height, stores the result under the seed, and never lets the seed be drawn twice.
//! Anyone can read it back with `get_draw(seed)` and re-derive the cards.

use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, NearToken, PanicOnDefault};

/// Covers the storage of one draw (about 200 bytes) with headroom.
pub const DRAW_DEPOSIT: NearToken = NearToken::from_millinear(3);

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Draws,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Draw {
    /// Account that requested the draw.
    pub account: AccountId,
    /// 32 bytes of randomness, hex encoded.
    pub randomness: String,
    pub block_height: u64,
    pub timestamp_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct PokenearRng {
    draws: LookupMap<String, Draw>,
    total: u64,
}

fn is_seed(seed: &str) -> bool {
    seed.len() == 64 && seed.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

#[near]
impl PokenearRng {
    #[init]
    pub fn new() -> Self {
        Self { draws: LookupMap::new(Key::Draws), total: 0 }
    }

    /// Draw randomness for `seed` (64 lowercase hex chars). Requires `DRAW_DEPOSIT`.
    #[payable]
    pub fn draw(&mut self, seed: String) -> Draw {
        require!(is_seed(&seed), "seed must be 64 lowercase hex characters");
        require!(env::attached_deposit() >= DRAW_DEPOSIT, "attach 0.003 NEAR for storage");
        require!(!self.draws.contains_key(&seed), "seed already drawn");

        let account = env::predecessor_account_id();
        let height = env::block_height();
        let mut input = env::random_seed();
        input.extend_from_slice(seed.as_bytes());
        input.extend_from_slice(account.as_bytes());
        input.extend_from_slice(&height.to_le_bytes());
        let randomness = hex(&env::sha256(&input));

        let draw = Draw { account, randomness, block_height: height, timestamp_ms: env::block_timestamp_ms() };
        self.draws.insert(seed.clone(), draw.clone());
        self.total += 1;
        env::log_str(&format!(
            "EVENT_JSON:{{\"standard\":\"pokenear-rng\",\"version\":\"1.0.0\",\"event\":\"draw\",\"data\":[{{\"seed\":\"{}\",\"account\":\"{}\",\"randomness\":\"{}\",\"block_height\":{}}}]}}",
            seed, draw.account, draw.randomness, draw.block_height
        ));
        draw
    }

    pub fn get_draw(&self, seed: String) -> Option<Draw> {
        self.draws.get(&seed).cloned()
    }

    pub fn total_draws(&self) -> u64 {
        self.total
    }
}

fn hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 15) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, VMContextBuilder};
    use near_sdk::testing_env;

    const SEED_A: &str = "aa00000000000000000000000000000000000000000000000000000000000001";
    const SEED_B: &str = "bb00000000000000000000000000000000000000000000000000000000000002";

    fn ctx(who: usize, deposit: NearToken, random: u8, height: u64) {
        let mut b = VMContextBuilder::new();
        b.predecessor_account_id(accounts(who))
            .attached_deposit(deposit)
            .random_seed([random; 32])
            .block_height(height);
        testing_env!(b.build());
    }

    #[test]
    fn draws_are_stored_and_readable() {
        ctx(1, DRAW_DEPOSIT, 7, 100);
        let mut c = PokenearRng::new();
        let d = c.draw(SEED_A.to_string());
        assert_eq!(d.account, accounts(1));
        assert_eq!(d.randomness.len(), 64);
        assert_eq!(d.block_height, 100);
        assert_eq!(c.get_draw(SEED_A.to_string()), Some(d));
        assert_eq!(c.get_draw(SEED_B.to_string()), None);
        assert_eq!(c.total_draws(), 1);
    }

    #[test]
    fn randomness_depends_on_chain_seed_and_input() {
        ctx(1, DRAW_DEPOSIT, 7, 100);
        let mut c = PokenearRng::new();
        let a = c.draw(SEED_A.to_string()).randomness;
        let b = c.draw(SEED_B.to_string()).randomness;
        assert_ne!(a, b);
        ctx(1, DRAW_DEPOSIT, 9, 100);
        let mut c2 = PokenearRng::new();
        assert_ne!(c2.draw(SEED_A.to_string()).randomness, a);
    }

    #[test]
    fn randomness_matches_documented_formula() {
        ctx(2, DRAW_DEPOSIT, 3, 42);
        let mut c = PokenearRng::new();
        let d = c.draw(SEED_A.to_string());
        let mut input = vec![3u8; 32];
        input.extend_from_slice(SEED_A.as_bytes());
        input.extend_from_slice(accounts(2).as_bytes());
        input.extend_from_slice(&42u64.to_le_bytes());
        assert_eq!(d.randomness, hex(&env::sha256(&input)));
    }

    #[test]
    #[should_panic(expected = "seed already drawn")]
    fn a_seed_can_only_be_drawn_once() {
        ctx(1, DRAW_DEPOSIT, 7, 100);
        let mut c = PokenearRng::new();
        c.draw(SEED_A.to_string());
        ctx(3, DRAW_DEPOSIT, 8, 101);
        c.draw(SEED_A.to_string());
    }

    #[test]
    #[should_panic(expected = "attach 0.003 NEAR")]
    fn deposit_is_required() {
        ctx(1, NearToken::from_millinear(1), 7, 100);
        PokenearRng::new().draw(SEED_A.to_string());
    }

    #[test]
    #[should_panic(expected = "seed must be 64 lowercase hex")]
    fn seed_format_is_checked() {
        ctx(1, DRAW_DEPOSIT, 7, 100);
        PokenearRng::new().draw("ABC".to_string());
    }
}
