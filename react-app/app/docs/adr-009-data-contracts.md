# ADR-009: React Data Layer — Supabase Client, React Query, Real-time Hooks

**Status:** Accepted  
**Date:** 2026-05-06  
**Decision Type:** Architecture (D-211 Phase 0)

---

## Context

The D-211 React migration requires a centralized, type-safe data layer that:
- Wraps the Supabase JavaScript client as a singleton
- Manages caching and request deduplication via React Query
- Supports real-time subscriptions for claims, bids, and notifications
- Provides clean error boundaries and fallback strategies
- Is fully tested with mock Supabase clients

This ADR defines the contracts, key conventions, and error handling strategy for all React data operations.

---

## Decision

We implement a three-layer architecture:

1. **Singleton Supabase Client** (`lib/supabase.ts`)
   - Single instance per browser session
   - Configured with `sb_at` storage key (not deprecated `sq_at`)
   - Environment-aware: throws at module load if env vars missing
   - Never instantiated client-side for admin operations

2. **React Query Configuration** (`lib/query-client.ts`)
   - Global defaults: `staleTime: 30s`, `retry: 2`, `gcTime: 5min`
   - QueryClient singleton exported alongside provider wrapper
   - Error handler: logs to console in dev, silent in prod

3. **Real-time Hooks** (in `hooks/`)
   - `useClaimStatus`: Subscribes to single claim changes
   - `useBidUpdates`: Subscribes to bid list for a claim
   - `useNotificationCount`: Subscribes to unread notification count
   - All implement subscription cleanup on unmount
   - All provide fallback polling via React Query on realtime failure

---

## Data Contracts

### Claims Table

```typescript
interface ClaimData {
  id: string;
  user_id: string;
  title: string;
  description: string;
  status: 'open' | 'in_progress' | 'completed' | 'closed';
  created_at: string;
  updated_at: string;
  budget: number;
  deadline?: string;
}
```

**React Query Key:** `['claims', claimId]`  
**Real-time Channel:** `claim-status-${claimId}`  
**Subscription Filter:** `id=eq.${claimId}`

### Quotes (Bids) Table

```typescript
interface BidData {
  id: string;
  claim_id: string;
  contractor_id: string;
  amount: number;
  message: string;
  status: 'pending' | 'accepted' | 'rejected';
  created_at: string;
  updated_at: string;
}
```

**React Query Key:** `['bids', claimId]`  
**Real-time Channel:** `bid-updates-${claimId}`  
**Subscription Filter:** `claim_id=eq.${claimId}`  
**Events:** INSERT (new bid), UPDATE (status change)

### Notifications Table

```typescript
interface NotificationData {
  id: string;
  user_id: string;
  type: 'bid' | 'message' | 'system';
  message: string;
  read: boolean;
  created_at: string;
}
```

**React Query Key:** `['notifications', 'count', userId]`  
**Real-time Channel:** `notifications-${userId}`  
**Subscription Filter:** `user_id=eq.${userId} AND read=eq.false`

### Contractors Table

```typescript
interface ContractorData {
  id: string;
  user_id: string;
  company_name: string;
  bio: string;
  specialties: string[];
  rating: number;
  total_bids: number;
  created_at: string;
  updated_at: string;
}
```

**React Query Key:** `['contractors', contractorId]`  
**No real-time subscription** (read-only for MVP)

---

## Real-time Subscription Strategy

### Channel Naming

All real-time channels follow the pattern:
```
${entityType}-${scope}-${identifier}
```

Examples:
- `claim-status-abc123` — single claim updates
- `bid-updates-abc123` — all bids for a claim
- `notifications-user456` — user's notifications

### Filter Predicates

Supabase Realtime filters use simple equality and comparison operators:
```
user_id=eq.${userId}
claim_id=eq.${claimId} AND read=eq.false
```

### Fallback Strategy

If a real-time subscription fails to connect:
1. Log the error in dev, silently swallow in prod
2. Fall back to React Query polling at default `refetchInterval: 5000ms`
3. Retry subscription connect every 30s via hook state machine

### Cleanup

Every hook must:
```typescript
useEffect(() => {
  // subscribe
  const subscription = supabase.channel(...).subscribe();
  return () => {
    supabase.removeChannel(subscription);
  };
}, [dependencies]);
```

---

## React Query Key Conventions

All keys are arrays with predictable structure for cache invalidation:

```typescript
// Single entity reads
['claims', claimId]
['bids', claimId]
['contractors', contractorId]
['notifications', 'count', userId]

// List reads
['bids', 'list', claimId]
['notifications', 'list', userId]
```

Invalidation on mutation:
```typescript
// After creating a bid, invalidate all bids for the claim
queryClient.invalidateQueries({ queryKey: ['bids', claimId] });

// After marking notification read, invalidate count
queryClient.invalidateQueries({ queryKey: ['notifications', 'count'] });
```

---

## Error Handling Contract

### Hook-level errors

Errors that bubble to the caller (component):
- Network failures (no internet)
- Supabase 401 Unauthorized (session expired)
- 403 Forbidden (insufficient permissions)

Errors handled silently at hook level:
- Real-time subscription failures → fallback to polling
- Transient 500s → automatic retry up to 2x per React Query config
- Timeout errors → log in dev, resolve to `null` in prod

### Error shapes

```typescript
interface UseClaimStatusResult {
  claim: ClaimData | null;
  loading: boolean;
  error: Error | null;
  retry?: () => void;
}
```

Error object includes:
- `error.message` — human-readable description
- `error.code` — error classification (network, auth, schema, etc.)
- `error.retryable` — whether retry might succeed

---

## Storage and Auth

### Session Storage

Supabase auth state persists to `sb_at` key in localStorage (via `storageKey` config in `supabase.ts`).

### Environment Variables

Required at build time:
```
NEXT_PUBLIC_SUPABASE_URL=https://yeszghaspzwwstvsrioa.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Service role key (server-side only, never shipped to browser):
```
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

---

## Testing Strategy

All hooks are tested with a mock Supabase client:
```typescript
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    channel: vi.fn(),
    removeChannel: vi.fn(),
  })),
}));
```

Each hook test includes 4 cases:
1. Returns `loading: true` initially
2. Returns data after successful fetch
3. Handles real-time INSERT/UPDATE event
4. Cleans up subscription on unmount

---

## Implementation Status

- [ ] Supabase client singleton (`lib/supabase.ts`)
- [ ] React Query configuration (`lib/query-client.ts`)
- [ ] useClaimStatus hook
- [ ] useBidUpdates hook
- [ ] useNotificationCount hook
- [ ] Hook unit tests (12 cases total)
- [ ] Integration test (all hooks together)
- [ ] `.env.example` updated
- [ ] `package.json` updated with deps + test scripts

