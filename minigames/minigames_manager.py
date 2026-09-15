import os
import json
import logging
import random
import uuid
from datetime import datetime, date
from supabase_client import get_supabase_client
from .blockchain import minigames_blockchain
from .weekly_limit import (
    week_key,
    week_reset_at,
    week_reset_label,
    week_start_date,
    weekly_limit_message,
    weekly_withdrawal_limit,
)

logger = logging.getLogger(__name__)


def normalize_tx_hash(tx_hash: str) -> str:
    """Ensure tx_hash has 0x prefix for Celo Explorer"""
    if not tx_hash:
        return tx_hash
    if not tx_hash.startswith('0x'):
        return '0x' + tx_hash
    return tx_hash


class MinigamesManager:
    def __init__(self):
        self.supabase = get_supabase_client()
        self.blockchain_service = minigames_blockchain

        # Deposit configurations
        self.MIN_DEPOSIT = 100.0  # Minimum deposit 100 G$
        self.MAX_DEPOSIT = 500.0  # Maximum deposit per day 500 G$

        # Withdrawal configurations
        self.MIN_WITHDRAWAL = 500.0  # Minimum withdrawal 500 G$
        self.MAX_WITHDRAWAL = 10000.0  # Maximum withdrawal 10,000 G$

        # Weekly withdrawal allowance: a wallet may withdraw at most this much
        # per PHT calendar week. A larger balance is paid out 500 G$ at a time
        # across weeks instead of being emptied in one request.
        self.WEEKLY_WITHDRAWAL_LIMIT = weekly_withdrawal_limit()
        # Latched when the weekly-allowance table is missing/unreadable so the
        # withdraw path falls back to payout-log enforcement instead of failing.
        self._weekly_table_unavailable = False

        # Game configurations
        self.game_configs = {
            'crash_game': {
                'max_plays_per_day': 20,
                'min_bet': 10.0,
                'max_bet': 250.0,
                'base_reward': 4,
                'min_multiplier': 1.20,
                'max_multiplier': 5.00
            },
            'spin_wheel': {
                'max_plays_per_day': 10,
                'base_reward': 0,
                'segments': [0, 0, 2, 2, 4, 6, 10, 20],
            },
            'memory_card': {
                'max_plays_per_day': 5,
                'reward_per_match': 2.0,
                'base_reward': 0,
            },
            'coin_click': {
                'max_plays_per_day': 10,
                'daily_reward_cap': 50.0,
                'max_reward_per_play': 10.0,
                'duration_seconds': 37,
                'coin_values': [1, 2, 5],
                'bomb_penalty': 2,
                'base_reward': 0,
            }
        }

        logger.info("🎮 Minigames Manager initialized")

    def get_deposit_balance(self, wallet_address: str) -> dict:
        # Use 30-second cache for balance (shorter because it changes frequently)
        cache_key = f'minigame_balance_{wallet_address}'
        if hasattr(self, '_cache'):
            if cache_key in self._cache:
                cached_data, cached_time = self._cache[cache_key]
                import time
                if time.time() - cached_time < 30:  # 30 seconds
                    logger.info(f"📦 Using cached minigame balance for {wallet_address[:8]}...")
                    return cached_data
        else:
            self._cache = {}

        try:
            # Get user's game balance record
            balance_result = self.supabase.table('minigame_balances')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .execute()

            if balance_result.data:
                balance_data = balance_result.data[0]
                # Merge deposited_amount and available_winnings into single balance
                available_balance = balance_data.get('available_balance', 0)
                result = {
                    'success': True,
                    'available_balance': available_balance,
                    'total_withdrawn': balance_data.get('total_withdrawn', 0),
                    'last_deposit_date': balance_data.get('last_deposit_date')
                }
            else:
                result = {
                    'success': True,
                    'available_balance': 0,
                    'total_withdrawn': 0,
                    'last_deposit_date': None
                }

            # Cache the result
            import time
            self._cache[cache_key] = (result, time.time())

            return result

        except Exception as e:
            logger.error(f"❌ Error getting deposit balance: {e}")
            error_result = {'success': False, 'error': str(e)}

            # Cache error too
            import time
            self._cache[cache_key] = (error_result, time.time())

            return error_result

    async def auto_verify_pending_deposits(self, wallet_address: str) -> dict:
        """
        Automatically verify pending deposits for a wallet
        Similar to P2P trading's automatic verification
        """
        try:
            logger.info(f"🔍 AUTO-VERIFY: Checking pending deposits for {wallet_address[:8]}...")

            # Get user's current balance
            balance_info = self.get_deposit_balance(wallet_address)
            today = date.today().isoformat()

            # Check blockchain for deposits
            deposits_result = await self.blockchain_service.check_pending_deposits(wallet_address)

            if not deposits_result.get('success'):
                return deposits_result

            deposits_found = deposits_result.get('deposits_found', [])

            if len(deposits_found) == 0:
                return {
                    'success': True,
                    'deposits_verified': 0,
                    'message': 'No pending deposits found'
                }

            # Get already recorded deposits
            recorded_deposits = self.supabase.table('minigame_deposits_log')\
                .select('tx_hash')\
                .eq('wallet_address', wallet_address)\
                .execute()

            recorded_tx_hashes = [d['tx_hash'] for d in (recorded_deposits.data or [])]

            # Process new deposits
            verified_count = 0
            total_new_amount = 0

            for deposit in deposits_found:
                tx_hash = deposit['tx_hash']
                amount = deposit['amount']

                # Skip if already recorded
                if tx_hash in recorded_tx_hashes:
                    logger.info(f"⏭️ Skipping already recorded deposit: {tx_hash[:16]}...")
                    continue

                # Check amount is within bounds
                if amount < self.MIN_DEPOSIT or amount > self.MAX_DEPOSIT:
                    logger.warning(f"⚠️ Deposit {tx_hash[:16]}... amount {amount} G$ out of bounds, skipping")
                    continue

                # Record the deposit
                try:
                    # Update or create balance record - add directly to available_balance
                    existing = self.supabase.table('minigame_balances')\
                        .select('*')\
                        .eq('wallet_address', wallet_address)\
                        .execute()

                    if existing.data:
                        current = existing.data[0]
                        new_balance = current.get('available_balance', 0) + amount

                        self.supabase.table('minigame_balances')\
                            .update({
                                'available_balance': new_balance,
                                'last_deposit_date': today,
                                'updated_at': datetime.now().isoformat()
                            })\
                            .eq('wallet_address', wallet_address)\
                            .execute()
                    else:
                        self.supabase.table('minigame_balances').insert({
                            'wallet_address': wallet_address,
                            'available_balance': amount,
                            'total_withdrawn': 0,
                            'last_deposit_date': today,
                            'created_at': datetime.now().isoformat()
                        }).execute()

                    # Log the deposit
                    self.supabase.table('minigame_deposits_log').insert({
                        'wallet_address': wallet_address,
                        'amount': amount,
                        'tx_hash': tx_hash,
                        'deposit_date': today
                    }).execute()

                    verified_count += 1
                    total_new_amount += amount
                    logger.info(f"✅ Auto-verified deposit: {amount} G$ (TX: {tx_hash[:16]}...)")

                except Exception as record_error:
                    logger.error(f"❌ Error recording deposit {tx_hash[:16]}...: {record_error}")
                    continue

            return {
                'success': True,
                'deposits_verified': verified_count,
                'total_amount': total_new_amount,
                'message': f'Verified {verified_count} deposit(s) totaling {total_new_amount} G$'
            }

        except Exception as e:
            logger.error(f"❌ Error auto-verifying deposits: {e}")
            return {'success': False, 'error': str(e), 'deposits_verified': 0}

    def check_daily_limit(self, wallet_address: str, game_type: str) -> dict:
        """Check if user can play the game today"""
        try:
            today = date.today()

            limit_check = self.supabase.table('daily_game_limits')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .eq('game_type', game_type)\
                .eq('game_date', today.isoformat())\
                .execute()

            max_plays = self.game_configs[game_type]['max_plays_per_day']

            if limit_check.data:
                plays_today = limit_check.data[0]['plays_today']
                can_play = plays_today < max_plays
                remaining = max(0, max_plays - plays_today)
            else:
                can_play = True
                plays_today = 0
                remaining = max_plays

            return {
                'can_play': can_play,
                'plays_today': plays_today,
                'remaining_plays': remaining,
                'max_plays': max_plays
            }

        except Exception as e:
            logger.error(f"❌ Error checking daily limit: {e}")
            return {'can_play': True, 'plays_today': 0, 'remaining_plays': 10, 'max_plays': 10}

    def start_game_session(self, wallet_address: str, game_type: str, bet_amount: float = 0) -> dict:
        """Start a new game session"""
        try:
            if game_type not in self.game_configs:
                return {'success': False, 'error': 'Game type is not available'}

            # Check daily limit
            limit_check = self.check_daily_limit(wallet_address, game_type)

            if not limit_check['can_play']:
                return {
                    'success': False,
                    'error': f"Daily limit reached ({limit_check['max_plays']} plays). Come back tomorrow!"
                }

            # Crash game and CoinClick are FREE - no bet deduction needed
            if game_type in ['crash_game', 'coin_click']:
                # Game is free, no balance checking or deduction
                bet_amount = 0
                logger.info(f"🎮 Starting FREE {game_type} for {wallet_address[:8]}...")

            session_id = f"GAME-{uuid.uuid4().hex[:8].upper()}"

            session_data = {
                'session_id': session_id,
                'wallet_address': wallet_address,
                'game_type': game_type,
                'status': 'in_progress',
                'bet_amount': bet_amount if (game_type == 'crash_game' or game_type == 'coin_flip') else 0,
                'started_at': datetime.now().isoformat()
            }

            self.supabase.table('minigame_sessions').insert(session_data).execute()

            logger.info(f"🎮 Started {game_type} session {session_id} for {wallet_address[:8]}... (bet: {bet_amount} G$)")

            return {
                'success': True,
                'session_id': session_id,
                'game_type': game_type,
                'bet_amount': bet_amount,
                'config': self.game_configs[game_type]
            }

        except Exception as e:
            logger.error(f"❌ Error starting game session: {e}")
            return {'success': False, 'error': str(e)}

    async def complete_game_session(self, session_id: str, score: int, game_data: dict = None) -> dict:
        """Complete a game session and calculate rewards"""
        try:
            # Get session
            session = self.supabase.table('minigame_sessions')\
                .select('*')\
                .eq('session_id', session_id)\
                .execute()

            if not session.data:
                return {'success': False, 'error': 'Session not found'}

            session_info = session.data[0]
            wallet_address = session_info['wallet_address']
            game_type = session_info['game_type']

            if session_info.get('status') == 'completed':
                return {'success': False, 'error': 'Game session already completed'}

            # CoinClick: reward clicked GoodDollar coins, enforce 10 plays/day and 50 G$/day cap.
            if game_type == 'coin_click':
                config = self.game_configs[game_type]
                earned_today = self._get_earned_today(wallet_address, game_type)
                daily_remaining = max(0.0, config['daily_reward_cap'] - earned_today)

                clicked_value = float(game_data.get('clicked_value', score) if game_data else score)
                bombs_hit = int(game_data.get('bombs_hit', 0) if game_data else 0)
                penalty = max(0, bombs_hit) * config['bomb_penalty']
                requested_reward = max(0.0, clicked_value - penalty)
                winnings = min(requested_reward, config['max_reward_per_play'], daily_remaining)
                score_int = int(max(0, clicked_value))

                self.supabase.table('minigame_sessions')\
                    .update({
                        'score': score_int,
                        'g_dollar_earned': winnings,
                        'game_data': game_data or {},
                        'status': 'completed',
                        'completed_at': datetime.now().isoformat()
                    })\
                    .eq('session_id', session_id)\
                    .execute()

                self._update_daily_limits(wallet_address, game_type, winnings)
                self._update_user_stats(wallet_address, game_type, score_int, winnings)
                new_balance = self._add_to_available_balance(wallet_address, winnings)
                updated_limit = self.check_daily_limit(wallet_address, game_type)

                return {
                    'success': True,
                    'score': score_int,
                    'winnings': winnings,
                    'reward': winnings,
                    'available_balance': new_balance,
                    'daily_earned': min(config['daily_reward_cap'], earned_today + winnings),
                    'daily_reward_cap': config['daily_reward_cap'],
                    'remaining_plays': updated_limit.get('remaining_plays', 0),
                    'plays_today': updated_limit.get('plays_today', 0),
                    'message': f'Collected {winnings} G$! Daily cap: {min(config["daily_reward_cap"], earned_today + winnings):.2f}/{config["daily_reward_cap"]:.0f} G$'
                }

            # For crash_game, calculate winnings using tier-based reward system
            if game_type == 'crash_game':
                bet_amount = session_info.get('bet_amount', 0)
                winnings = float(score)  # Total winnings from frontend (tier-based)
                
                # TIER-BASED REWARD SYSTEM:
                # 1.1x-1.9x = 4 G$, 2x-2.9x = 8 G$, 3x-3.9x = 12 G$, 4x-4.9x = 16 G$, 5x = 20 G$
                
                # Validate winnings match expected tiers
                multiplier_str = game_data.get('multiplier', '0.00') if game_data else '0.00'
                try:
                    multiplier_value = float(multiplier_str)
                    score_int = int(multiplier_value * 100)  # Store multiplier as integer (e.g., 1.69x = 169)
                    
                    # Verify winnings match tier
                    expected_winnings = 4.0
                    if multiplier_value >= 2.0:
                        expected_winnings = 8.0
                    if multiplier_value >= 3.0:
                        expected_winnings = 12.0
                    if multiplier_value >= 4.0:
                        expected_winnings = 16.0
                    if multiplier_value >= 5.0:
                        expected_winnings = 20.0
                    
                    # Cap at expected amount to prevent abuse
                    if winnings > expected_winnings:
                        logger.warning(f"⚠️ Winnings {winnings} exceed expected {expected_winnings} for {multiplier_value}x, capping")
                        winnings = expected_winnings
                except:
                    score_int = 0

                # Update session
                self.supabase.table('minigame_sessions')\
                    .update({
                        'score': score_int,
                        'g_dollar_earned': winnings,
                        'game_data': game_data or {},
                        'status': 'completed',
                        'completed_at': datetime.now().isoformat()
                    })\
                    .eq('session_id', session_id)\
                    .execute()

                # Update daily limits
                self._update_daily_limits(wallet_address, game_type, winnings)

                # Add winnings to available balance
                balance_result = self.supabase.table('minigame_balances')\
                    .select('*')\
                    .eq('wallet_address', wallet_address)\
                    .execute()

                if balance_result.data:
                    current_balance = balance_result.data[0]
                    old_balance = current_balance.get('available_balance', 0)
                    new_balance = old_balance + winnings

                    logger.info(f"💰 BALANCE UPDATE for {wallet_address[:8]}...")
                    logger.info(f"   Bet amount: {bet_amount} G$ (already deducted)")
                    logger.info(f"   Winnings to add: {winnings} G$")
                    logger.info(f"   Old balance: {old_balance} G$")
                    logger.info(f"   New balance: {new_balance} G$")
                    logger.info(f"   Net change: {winnings} G$")

                    self.supabase.table('minigame_balances')\
                        .update({
                            'available_balance': new_balance,
                            'updated_at': datetime.now().isoformat()
                        })\
                        .eq('wallet_address', wallet_address)\
                        .execute()

                    # Clear balance cache to force refresh
                    cache_key = f'minigame_balance_{wallet_address}'
                    if hasattr(self, '_cache') and cache_key in self._cache:
                        del self._cache[cache_key]

                    logger.info(f"✅ Game complete: {wallet_address[:8]}... won {winnings} G$")
                    logger.info(f"💰 New available balance: {new_balance} G$")

                    # Get updated limit info
                    limit_info = self.check_daily_limit(wallet_address, game_type)

                    return {
                        'success': True,
                        'score': score,
                        'winnings': winnings,
                        'available_balance': new_balance,
                        'can_withdraw': new_balance >= self.MIN_WITHDRAWAL,
                        'remaining_plays': limit_info.get('remaining_plays', 0),
                        'plays_today': limit_info.get('plays_today', 0),
                        'message': f'Won {winnings} G$! Total balance: {new_balance} G$'
                    }
                else:
                    return {
                        'success': False,
                        'error': 'No balance found. Please deposit G$ first to play.'
                    }

            else:
                # Other games: original instant reward logic
                reward_amount = self._calculate_reward(game_type, score, game_data)

                # Update session
                self.supabase.table('minigame_sessions')\
                    .update({
                        'score': score,
                        'g_dollar_earned': reward_amount,
                        'game_data': game_data or {},
                        'status': 'completed',
                        'completed_at': datetime.now().isoformat()
                    })\
                    .eq('session_id', session_id)\
                    .execute()

                # Update daily limits
                self._update_daily_limits(wallet_address, game_type, reward_amount)

                # Update user stats
                self._update_user_stats(wallet_address, game_type, score, reward_amount)

                # Disburse reward
                if reward_amount > 0:
                    disburse_result = await self.blockchain_service.disburse_game_reward(
                        wallet_address, reward_amount, game_type, session_id
                    )

                    if disburse_result['success']:
                        # Log reward
                        self.supabase.table('minigame_rewards_log').insert({
                            'transaction_hash': normalize_tx_hash(disburse_result['tx_hash']),
                            'wallet_address': wallet_address,
                            'game_type': game_type,
                            'session_id': session_id,
                            'reward_amount': reward_amount,
                            'score': score
                        }).execute()

                        return {
                            'success': True,
                            'score': score,
                            'reward': reward_amount,
                            'tx_hash': normalize_tx_hash(disburse_result['tx_hash']),
                            'explorer_url': disburse_result['explorer_url']
                        }
                    else:
                        return {
                            'success': False,
                            'error': disburse_result.get('error', 'Reward disbursement failed')
                        }
                else:
                    return {
                        'success': True,
                        'score': score,
                        'reward': 0,
                        'message': 'No reward earned'
                    }

        except Exception as e:
            logger.error(f"❌ Error completing game session: {e}")
            return {'success': False, 'error': str(e)}

    def _get_earned_today(self, wallet_address: str, game_type: str) -> float:
        """Return the amount earned today for a game type."""
        today = date.today().isoformat()
        result = self.supabase.table('daily_game_limits')\
            .select('earned_today')\
            .eq('wallet_address', wallet_address)\
            .eq('game_type', game_type)\
            .eq('game_date', today)\
            .execute()
        if result.data:
            return float(result.data[0].get('earned_today') or 0)
        return 0.0

    def _add_to_available_balance(self, wallet_address: str, amount: float) -> float:
        """Add minigame winnings to the user's withdrawable Play & Earn balance."""
        balance_result = self.supabase.table('minigame_balances')\
            .select('*')\
            .eq('wallet_address', wallet_address)\
            .execute()

        if balance_result.data:
            current_balance = balance_result.data[0]
            new_balance = float(current_balance.get('available_balance', 0) or 0) + amount
            self.supabase.table('minigame_balances')\
                .update({
                    'available_balance': new_balance,
                    'updated_at': datetime.now().isoformat()
                })\
                .eq('wallet_address', wallet_address)\
                .execute()
        else:
            new_balance = amount
            self.supabase.table('minigame_balances').insert({
                'wallet_address': wallet_address,
                'available_balance': new_balance,
                'total_withdrawn': 0,
                'created_at': datetime.now().isoformat(),
                'updated_at': datetime.now().isoformat()
            }).execute()

        cache_key = f'minigame_balance_{wallet_address}'
        if hasattr(self, '_cache') and cache_key in self._cache:
            del self._cache[cache_key]

        return new_balance

    def _calculate_reward(self, game_type: str, score: int, game_data: dict = None) -> float:
        """Calculate reward based on game type and score"""
        config = self.game_configs[game_type]

        if game_type == 'catch_dollar':
            return score * config['reward_per_dollar']

        elif game_type == 'quiz_trivia':
            return score * config['reward_per_correct']

        elif game_type == 'battles':
            if game_data and game_data.get('won'):
                return config['stake_amount'] * config['reward_multiplier']
            return 0

        elif game_type == 'memory_card':
            matches = game_data.get('matches', 0) if game_data else 0
            return matches * config['reward_per_match']

        elif game_type == 'spin_wheel':
            return score  # Score is the reward itself

        return 0

    def _update_daily_limits(self, wallet_address: str, game_type: str, earned: float):
        """Update daily play limits"""
        try:
            today = date.today()

            existing = self.supabase.table('daily_game_limits')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .eq('game_type', game_type)\
                .eq('game_date', today.isoformat())\
                .execute()

            if existing.data:
                self.supabase.table('daily_game_limits')\
                    .update({
                        'plays_today': existing.data[0]['plays_today'] + 1,
                        'earned_today': existing.data[0]['earned_today'] + earned
                    })\
                    .eq('id', existing.data[0]['id'])\
                    .execute()
            else:
                self.supabase.table('daily_game_limits').insert({
                    'wallet_address': wallet_address,
                    'game_date': today.isoformat(),
                    'game_type': game_type,
                    'plays_today': 1,
                    'earned_today': earned
                }).execute()

        except Exception as e:
            logger.error(f"❌ Error updating daily limits: {e}")

    def _update_user_stats(self, wallet_address: str, game_type: str, score: int, reward_amount: float) -> dict:
        """Update user game statistics"""
        try:
            existing = self.supabase.table('user_game_stats')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .eq('game_type', game_type)\
                .execute()

            if existing.data:
                stats = existing.data[0]
                self.supabase.table('user_game_stats')\
                    .update({
                        'total_plays': stats['total_plays'] + 1,
                        'total_score': stats['total_score'] + score,
                        'highest_score': max(stats['highest_score'], score),
                        'total_earned': stats['total_earned'] + reward_amount,
                        'last_played': datetime.now().isoformat()
                    })\
                    .eq('id', stats['id'])\
                    .execute()
            else:
                self.supabase.table('user_game_stats').insert({
                    'wallet_address': wallet_address,
                    'game_type': game_type,
                    'total_plays': 1,
                    'total_score': score,
                    'highest_score': score,
                    'total_earned': reward_amount,
                    'virtual_tokens': 0,
                    'last_played': datetime.now().isoformat()
                }).execute()

        except Exception as e:
            logger.error(f"❌ Error updating user stats: {e}")


    def _update_user_stats_with_tokens(self, wallet_address: str, game_type: str, score: int, tokens_earned: int) -> dict:
        """Update user game statistics with virtual tokens"""
        try:
            existing = self.supabase.table('user_game_stats')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .eq('game_type', game_type)\
                .execute()

            if existing.data:
                stats = existing.data[0]
                new_token_total = stats.get('virtual_tokens', 0) + tokens_earned

                result = self.supabase.table('user_game_stats')\
                    .update({
                        'total_plays': stats['total_plays'] + 1,
                        'total_score': stats['total_score'] + score,
                        'highest_score': max(stats['highest_score'], score),
                        'virtual_tokens': new_token_total,
                        'last_played': datetime.now().isoformat()
                    })\
                    .eq('id', stats['id'])\
                    .execute()

                logger.info(f"✅ Updated tokens: {stats.get('virtual_tokens', 0)} + {tokens_earned} = {new_token_total}")

                return {
                    'virtual_tokens': new_token_total,
                    'tokens_earned': tokens_earned,
                    'previous_tokens': stats.get('virtual_tokens', 0)
                }
            else:
                result = self.supabase.table('user_game_stats').insert({
                    'wallet_address': wallet_address,
                    'game_type': game_type,
                    'total_plays': 1,
                    'total_score': score,
                    'highest_score': score,
                    'total_earned': 0,
                    'virtual_tokens': tokens_earned,
                    'last_played': datetime.now().isoformat()
                }).execute()

                logger.info(f"✅ Created new stats with {tokens_earned} tokens")

                return {
                    'virtual_tokens': tokens_earned,
                    'tokens_earned': tokens_earned,
                    'previous_tokens': 0
                }

        except Exception as e:
            logger.error(f"❌ Error updating user stats with tokens: {e}")
            return {'virtual_tokens': 0, 'tokens_earned': 0, 'previous_tokens': 0}

    def _week_withdrawn_amount(self, wallet_address: str, wk: str) -> float:
        """Return how much this wallet already withdrew in ``wk``.

        The weekly row is the source of truth once it exists. The first time a
        wallet withdraws in a week the row is seeded from the payout log, so
        payouts made before this cap existed (or by any path that bypassed the
        counter) still count against the allowance.
        """
        result = self.supabase.table('minigame_weekly_withdrawals')\
            .select('amount')\
            .eq('wallet_address', wallet_address)\
            .eq('week_key', wk)\
            .execute()

        if result.data:
            return float(result.data[0].get('amount') or 0)

        seeded = self._week_payouts_from_log(wallet_address)
        try:
            self.supabase.table('minigame_weekly_withdrawals').insert({
                'wallet_address': wallet_address,
                'week_key': wk,
                'amount': seeded,
                'created_at': datetime.now().isoformat()
            }).execute()
        except Exception as seed_error:
            if self._is_duplicate_week_row(seed_error):
                # A concurrent request seeded the row first — read theirs back.
                retry = self.supabase.table('minigame_weekly_withdrawals')\
                    .select('amount')\
                    .eq('wallet_address', wallet_address)\
                    .eq('week_key', wk)\
                    .execute()
                if retry.data:
                    return float(retry.data[0].get('amount') or 0)
            raise

        return seeded

    @staticmethod
    def _is_duplicate_week_row(error) -> bool:
        """True when the insert lost the (wallet_address, week_key) unique race."""
        text = str(error).lower()
        return 'duplicate key' in text or 'unique constraint' in text

    def _week_payouts_from_log(self, wallet_address: str) -> float:
        """Sum this PHT week's completed payouts from the withdrawal log."""
        week_start = week_start_date().isoformat()
        try:
            result = self.supabase.table('minigame_withdrawals_log')\
                .select('amount, status, withdrawal_date')\
                .eq('wallet_address', wallet_address)\
                .gte('withdrawal_date', week_start)\
                .execute()
        except Exception as log_error:
            logger.warning(f"⚠️ Could not seed weekly allowance from log: {log_error}")
            return 0.0

        total = 0.0
        for row in result.data or []:
            status = str(row.get('status') or 'completed').lower()
            if status not in ('completed', 'success', 'successful'):
                continue
            total += float(row.get('amount') or 0)
        return total

    def _claim_week_allowance(self, wallet_address: str, wk: str, expected_used: float, amount: float):
        """CAS-increment this week's withdrawn total.

        Returns ``True`` when we won the claim, ``False`` when another request
        moved the counter first (caller should re-read and retry), and ``None``
        when the weekly table is unusable — e.g. the migration has not been
        applied yet. The caller falls back to payout-log enforcement on None so
        a missing table cannot lock users out of their money.
        """
        if self._weekly_table_unavailable:
            return None
        try:
            result = self.supabase.table('minigame_weekly_withdrawals')\
                .update({'amount': expected_used + amount, 'updated_at': datetime.now().isoformat()})\
                .eq('wallet_address', wallet_address)\
                .eq('week_key', wk)\
                .eq('amount', expected_used)\
                .execute()
            return bool(result.data)
        except Exception as claim_error:
            self._weekly_table_unavailable = True
            logger.error(
                f"⚠️ Weekly allowance table unusable ({claim_error}). Falling back to "
                f"payout-log enforcement — is sql/minigame_weekly_withdrawal_limit.sql applied?"
            )
            return None

    def _release_week_allowance(self, wallet_address: str, wk: str, amount: float):
        """Give back a claimed allowance after a failed payout."""
        try:
            current = self.supabase.table('minigame_weekly_withdrawals')\
                .select('amount')\
                .eq('wallet_address', wallet_address)\
                .eq('week_key', wk)\
                .execute()
            if not current.data:
                return
            used = float(current.data[0].get('amount') or 0)
            self.supabase.table('minigame_weekly_withdrawals')\
                .update({'amount': max(0.0, used - amount), 'updated_at': datetime.now().isoformat()})\
                .eq('wallet_address', wallet_address)\
                .eq('week_key', wk)\
                .execute()
        except Exception as release_error:
            logger.error(f"⚠️ Could not release weekly allowance: {release_error}")

    def get_weekly_withdrawal_status(self, wallet_address: str) -> dict:
        """Describe the wallet's remaining allowance for the current week.

        Never raises: balance polling and page loads must keep working even if
        the weekly-allowance table has not been migrated yet. In that case the
        payout log is the best available source of truth.
        """
        limit = self.WEEKLY_WITHDRAWAL_LIMIT
        wk = week_key()
        if self._weekly_table_unavailable:
            used = self._week_payouts_from_log(wallet_address)
        else:
            try:
                used = self._week_withdrawn_amount(wallet_address, wk)
            except Exception as usage_error:
                logger.error(
                    "⚠️ Could not read weekly withdrawal usage (%s). "
                    "Is sql/minigame_weekly_withdrawal_limit.sql applied?", usage_error
                )
                used = self._week_payouts_from_log(wallet_address)

        remaining = max(0.0, limit - used)
        return {
            'weekly_limit': limit,
            'weekly_withdrawn': used,
            'weekly_remaining': remaining,
            'weekly_limit_reached': remaining <= 0,
            'week_reset_label': week_reset_label(),
            'week_reset_at': week_reset_at().isoformat(),
        }

    async def withdraw_winnings(self, wallet_address: str) -> dict:
        """Withdraw available balance, capped by the weekly allowance.

        A wallet may withdraw at most ``WEEKLY_WITHDRAWAL_LIMIT`` G$ per PHT
        calendar week. A bigger balance is paid out in 500 G$ instalments —
        one per week — and the rest stays in the Play & Earn balance.
        """
        try:
            balance_result = self.supabase.table('minigame_balances')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .execute()

            if not balance_result.data:
                return {'success': False, 'error': 'No balance found'}

            balance_data = balance_result.data[0]
            available_balance = float(balance_data.get('available_balance', 0) or 0)

            if available_balance <= 0:
                return {
                    'success': False,
                    'error': 'No balance available to withdraw'
                }

            if available_balance < self.MIN_WITHDRAWAL:
                return {
                    'success': False,
                    'error': f'Minimum withdrawal is {self.MIN_WITHDRAWAL} G$. You have {available_balance} G$. Keep playing to reach the minimum!'
                }

            # Weekly allowance. The claim below is a compare-and-swap on the
            # week's running total, so concurrent requests can never
            # over-withdraw — the loser re-reads and retries.
            wk = week_key()
            weekly = self.get_weekly_withdrawal_status(wallet_address)
            used, remaining = weekly['weekly_withdrawn'], weekly['weekly_remaining']

            for _ in range(3):
                if remaining <= 0:
                    return {
                        'success': False,
                        'error': weekly_limit_message(self.WEEKLY_WITHDRAWAL_LIMIT),
                        'status': 'weekly_limit_reached',
                        'weekly_limit': self.WEEKLY_WITHDRAWAL_LIMIT,
                        'weekly_withdrawn': used,
                        'weekly_remaining': 0.0,
                        'week_reset_label': weekly['week_reset_label'],
                        'available_balance': available_balance,
                        'balance_safe': True,
                    }

                amount_to_withdraw = min(available_balance, remaining, self.MAX_WITHDRAWAL)

                if amount_to_withdraw < self.MIN_WITHDRAWAL:
                    return {
                        'success': False,
                        'error': (
                            f"Only {amount_to_withdraw:,.2f} G$ of this week's "
                            f'{self.WEEKLY_WITHDRAWAL_LIMIT:,.0f} G$ withdrawal limit is left, '
                            f'which is below the {self.MIN_WITHDRAWAL:,.0f} G$ minimum. '
                            f'Please withdraw again next week — your allowance resets on '
                            f"{weekly['week_reset_label']}."
                        ),
                        'status': 'weekly_limit_reached',
                        'weekly_limit': self.WEEKLY_WITHDRAWAL_LIMIT,
                        'weekly_withdrawn': used,
                        'weekly_remaining': remaining,
                        'week_reset_label': weekly['week_reset_label'],
                        'available_balance': available_balance,
                        'balance_safe': True,
                    }

                claim = self._claim_week_allowance(wallet_address, wk, used, amount_to_withdraw)
                if claim is True:
                    break
                if claim is None:
                    # Weekly table unavailable: enforce the cap from the payout
                    # log instead. Weaker under concurrency, but it keeps the
                    # 500 G$ rule and never blocks a legitimate payout.
                    recent = self._week_payouts_from_log(wallet_address)
                    if recent + amount_to_withdraw > self.WEEKLY_WITHDRAWAL_LIMIT:
                        logger.error(
                            f"⛔ Weekly withdrawal limit enforced from payout log for "
                            f"{wallet_address[:8]}... (weekly table unavailable)"
                        )
                        return {
                            'success': False,
                            'error': weekly_limit_message(self.WEEKLY_WITHDRAWAL_LIMIT),
                            'status': 'weekly_limit_reached',
                            'weekly_limit': self.WEEKLY_WITHDRAWAL_LIMIT,
                            'weekly_withdrawn': recent,
                            'weekly_remaining': max(0.0, self.WEEKLY_WITHDRAWAL_LIMIT - recent),
                            'week_reset_label': weekly['week_reset_label'],
                            'available_balance': available_balance,
                            'balance_safe': True,
                        }
                    break

                logger.info(f"🔁 Weekly allowance race for {wallet_address[:8]}..., retrying")
                weekly = self.get_weekly_withdrawal_status(wallet_address)
                used, remaining = weekly['weekly_withdrawn'], weekly['weekly_remaining']
            else:
                return {
                    'success': False,
                    'error': "Could not reserve this week's withdrawal allowance. Please try again.",
                    'balance_safe': True,
                    'available_balance': available_balance,
                    'retry_available': True,
                }

            # Disburse from GAMES_KEY via the GamesRewards contract)
            session_id = f"WITHDRAW-{uuid.uuid4().hex[:8].upper()}"
            disburse_result = await self.blockchain_service.disburse_from_games_key(
                wallet_address, amount_to_withdraw, session_id
            )

            # ONLY update balance if blockchain transaction was successful
            if disburse_result['success']:
                # Deduct just what was paid out; a balance above the weekly
                # allowance stays withdrawable in the weeks that follow.
                new_balance = max(0.0, available_balance - amount_to_withdraw)
                total_withdrawn = float(balance_data.get('total_withdrawn', 0) or 0) + amount_to_withdraw

                self.supabase.table('minigame_balances')\
                    .update({
                        'available_balance': new_balance,
                        'total_withdrawn': total_withdrawn,
                        'updated_at': datetime.now().isoformat()
                    })\
                    .eq('wallet_address', wallet_address)\
                    .execute()

                # Clear balance cache to force refresh
                cache_key = f'minigame_balance_{wallet_address}'
                if hasattr(self, '_cache') and cache_key in self._cache:
                    del self._cache[cache_key]

                # Log the withdrawal only after confirmed on-chain success.
                # Include status when the database has the column; fall back to
                # the legacy shape so a missing migration cannot block payouts.
                withdrawal_log = {
                    'wallet_address': wallet_address,
                    'amount': amount_to_withdraw,
                    'tx_hash': normalize_tx_hash(disburse_result['tx_hash']),
                    'session_id': session_id,
                    'status': 'completed',
                    'withdrawal_date': date.today().isoformat()
                }
                try:
                    self.supabase.table('minigame_withdrawals_log').insert(withdrawal_log).execute()
                except Exception as log_error:
                    if 'status' not in str(log_error).lower():
                        raise
                    logger.warning(
                        "⚠️ minigame_withdrawals_log.status missing; "
                        "falling back to legacy withdrawal log insert"
                    )
                    withdrawal_log.pop('status', None)
                    self.supabase.table('minigame_withdrawals_log').insert(withdrawal_log).execute()

                # Stamp the payout hash on the weekly row for support lookups.
                try:
                    self.supabase.table('minigame_weekly_withdrawals')\
                        .update({
                            'tx_hash': normalize_tx_hash(disburse_result['tx_hash']),
                            'session_id': session_id,
                        })\
                        .eq('wallet_address', wallet_address)\
                        .eq('week_key', wk)\
                        .execute()
                except Exception as stamp_error:
                    logger.warning(f"⚠️ Could not stamp weekly withdrawal hash: {stamp_error}")

                weekly_remaining_after = max(0.0, remaining - amount_to_withdraw)
                logger.info(
                    f"✅ Balance withdrawn successfully: {amount_to_withdraw} G$ "
                    f"(remaining balance {new_balance} G$, weekly allowance left {weekly_remaining_after} G$)"
                )

                if new_balance > 0 and weekly_remaining_after <= 0:
                    message = (
                        f'Successfully withdrawn {amount_to_withdraw:,.2f} G$! '
                        f'{new_balance:,.2f} G$ stays in your Play & Earn balance. '
                        f'Please withdraw again next week — your allowance resets on '
                        f"{weekly['week_reset_label']}."
                    )
                elif weekly_remaining_after > 0:
                    message = (
                        f'Successfully withdrawn {amount_to_withdraw:,.2f} G$! '
                        f"{weekly_remaining_after:,.2f} G$ of this week's withdrawal limit is still available."
                    )
                else:
                    message = f'Successfully withdrawn {amount_to_withdraw:,.2f} G$!'

                return {
                    'success': True,
                    'amount_withdrawn': amount_to_withdraw,
                    'remaining_balance': new_balance,
                    'weekly_limit': self.WEEKLY_WITHDRAWAL_LIMIT,
                    'weekly_withdrawn': used + amount_to_withdraw,
                    'weekly_remaining': weekly_remaining_after,
                    'week_reset_label': weekly['week_reset_label'],
                    'tx_hash': normalize_tx_hash(disburse_result['tx_hash']),
                    'explorer_url': disburse_result['explorer_url'],
                    'message': message
                }
            else:
                # Withdrawal FAILED - give back the reserved allowance and
                # leave the balance untouched so the user can retry.
                self._release_week_allowance(wallet_address, wk, amount_to_withdraw)
                logger.error(f"❌ Blockchain withdrawal failed: {disburse_result.get('error')}")

                # Check if it's a gas/system error
                error_type = disburse_result.get('error_type')
                if error_type == 'insufficient_gas':
                    error_message = "Withdrawal signer needs gas refill. Please try again in a few minutes. Your balance is safe."
                elif error_type == 'insufficient_contract_balance':
                    error_message = "Withdrawal vault has insufficient G$ right now. Please try again later. Your balance is safe."
                elif error_type == 'contract_preflight_failed':
                    error_message = "Withdrawal failed contract preflight, so no transaction was sent. Please try again later. Your balance is safe."
                elif error_type == 'onchain_reverted':
                    error_message = "Withdrawal transaction reverted on-chain, so it was not completed. Your balance is safe."
                else:
                    error_message = f"Withdrawal failed: {disburse_result.get('error', 'Unknown error')}. Your balance is safe."

                return {
                    'success': False,
                    'error': error_message,
                    'balance_safe': True,
                    'available_balance': available_balance,
                    'retry_available': True,
                    'status': 'failed',
                    'error_type': error_type or 'withdrawal_failed'
                }

        except Exception as e:
            logger.error(f"❌ Error withdrawing balance: {e}")
            return {
                'success': False,
                'error': f'Withdrawal error: {str(e)}. Your balance is safe.',
                'balance_safe': True
            }

    def get_user_stats(self, wallet_address: str) -> dict:
        """Get user game statistics"""
        try:
            logger.info(f"🔍 Querying user_game_stats for {wallet_address[:8]}...")

            stats = self.supabase.table('user_game_stats')\
                .select('*')\
                .eq('wallet_address', wallet_address)\
                .execute()

            stats_data = stats.data or []
            logger.info(f"📊 Found {len(stats_data)} game records for {wallet_address[:8]}...")

            if stats_data:
                for stat in stats_data:
                    logger.info(f"   Game: {stat.get('game_type')}, Tokens: {stat.get('virtual_tokens', 0)}")

            return {
                'success': True,
                'stats': stats_data
            }

        except Exception as e:
            logger.error(f"❌ Error getting user stats: {e}")
            import traceback
            logger.error(f"🔍 Traceback: {traceback.format_exc()}")
            return {'success': True, 'error': str(e), 'stats': []}

    def get_quiz_questions(self, difficulty: str = None) -> list:
        """Get random quiz questions (using Learn & Earn schema)"""
        try:
            # Use Learn & Earn schema: question_id, question, answer_a, answer_b, answer_c, answer_d, correct
            query = self.supabase.table('quiz_questions').select('*')

            questions = query.execute()

            if questions.data:
                # Randomize and limit to 10
                random.shuffle(questions.data)
                quiz_questions = []

                for i, q in enumerate(questions.data[:10]):
                    quiz_questions.append({
                        'question_number': i + 1,
                        'question_id': q.get('question_id'),
                        'question': q.get('question'),
                        'options': [
                            q.get('answer_a'),
                            q.get('answer_b'),
                            q.get('answer_c'),
                            q.get('answer_d')
                        ],
                        'correct_answer': ord(q.get('correct', 'A')) - ord('A')  # Convert A,B,C,D to 0,1,2,3
                    })

                return quiz_questions

            return []

        except Exception as e:
            logger.error(f"❌ Error getting quiz questions: {e}")
            return []

# Global instance
minigames_manager = MinigamesManager()
