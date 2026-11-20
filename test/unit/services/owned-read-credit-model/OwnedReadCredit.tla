--------------------------- MODULE OwnedReadCredit ---------------------------
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Capacity, Extents, MaxWaiters, EarlyReturn
ModelExtents == <<2, 2, 1, 1>>
Requests == 1..Len(Extents)
ASSUME /\ Capacity \in Nat
       /\ MaxWaiters \in Nat
       /\ \A id \in Requests : Extents[id] \in 1..Capacity

VARIABLE book
Init ==
  book = [claims |-> [id \in Requests |->
                       [owner |-> "new", io |-> "idle", reply |-> "open",
                        cancelled |-> FALSE, released |-> FALSE,
                        debits |-> 0, refunds |-> 0]],
          queue |-> <<>>, live |-> 0, retired |-> 0]

Change(state, id, claim) == [state EXCEPT !.claims[id] = claim]
Fits(state, id) == state.live + Extents[id] <= Capacity
CanBypassQueue(state, id) == Len(state.queue) = 0 /\ Fits(state, id)

Charge(state, id, owner) ==
  LET claim == state.claims[id]
  IN [Change(state, id, [claim EXCEPT !.owner = owner, !.debits = @ + 1])
      EXCEPT !.live = @ + Extents[id]]

RECURSIVE Drain(_)
Drain(state) ==
  IF Len(state.queue) = 0 THEN state
  ELSE LET head == Head(state.queue) IN
    IF Fits(state, head)
    THEN Drain([Charge(state, head, "granted") EXCEPT !.queue = Tail(@)])
    ELSE state

Refund(state, id, wasRetired) ==
  LET updated == [state EXCEPT !.claims[id].refunds = @ + 1,
                              !.live = @ - Extents[id]]
  IN Drain(IF wasRetired THEN [updated EXCEPT !.retired = @ - Extents[id]]
           ELSE updated)

Submit(id) ==
  /\ book.claims[id].owner = "new"
  /\ IF CanBypassQueue(book, id)
     THEN book' = Charge(book, id, "granted")
     ELSE IF Len(book.queue) = MaxWaiters
          THEN book' = [book EXCEPT !.claims[id].owner = "denied",
                                    !.claims[id].reply = "queue full"]
          ELSE book' = [book EXCEPT !.claims[id].owner = "queued",
                                    !.queue = Append(@, id)]

TryRetained(id) ==
  /\ book.claims[id].owner = "new"
  /\ IF CanBypassQueue(book, id)
     THEN book' = Charge(book, id, "retained")
     ELSE book' = [book EXCEPT !.claims[id].owner = "denied",
                               !.claims[id].reply = "no credit"]

Remove(sequence, id) == SelectSeq(sequence, LAMBDA queued : queued # id)
LeaveQueue(id, reason) ==
  /\ book.claims[id].owner = "queued"
  /\ book' = Drain([book EXCEPT !.queue = Remove(@, id),
                                 !.claims[id].owner = "denied",
                                 !.claims[id].reply = reason])

CancelGrant(id) ==
  /\ book.claims[id].owner = "granted"
  /\ ~book.claims[id].cancelled
  /\ book' = [book EXCEPT !.claims[id].cancelled = TRUE]

Resume(id) ==
  /\ book.claims[id].owner = "granted"
  /\ LET claim == book.claims[id]
         lease == Change(book, id, [claim EXCEPT !.owner = "scoped"])
     IN IF claim.cancelled
        THEN book' = Refund([lease EXCEPT !.claims[id].released = TRUE,
                                          !.claims[id].reply = "abort"], id, FALSE)
        ELSE book' = [lease EXCEPT !.claims[id].io = "pending"]

Leased(claim) == claim.owner \in {"scoped", "retained"}
StartRetained(id) ==
  /\ book.claims[id].owner = "retained"
  /\ ~book.claims[id].released
  /\ book.claims[id].io = "idle"
  /\ book' = [book EXCEPT !.claims[id].io = "pending"]

DuplicateBegin(id) ==
  /\ book.claims[id].owner = "retained"
  /\ (book.claims[id].io # "idle" \/ book.claims[id].released)
  /\ UNCHANGED book

Release(id) ==
  /\ LET claim == book.claims[id] IN
     /\ Leased(claim)
     /\ ~claim.released
     /\ \/ claim.owner = "retained"
        \/ claim.io = "fulfilled"
     /\ LET released == [book EXCEPT !.claims[id].released = TRUE]
        IN IF claim.io = "pending"
           THEN book' = [released EXCEPT !.retired = @ + Extents[id]]
           ELSE book' = Refund(released, id, FALSE)

AbortRead(id) ==
  /\ LET claim == book.claims[id] IN
     /\ claim.io = "pending"
     /\ claim.reply = "open"
     /\ LET retired == IF claim.released THEN book
                       ELSE [book EXCEPT !.retired = @ + Extents[id]]
            cancelled == [retired EXCEPT !.claims[id].released = TRUE,
                                         !.claims[id].reply = "abort"]
        IN book' = IF EarlyReturn THEN Refund(cancelled, id, TRUE) ELSE cancelled

Settle(id, result) ==
  /\ LET claim == book.claims[id]
         reply == IF claim.reply = "abort" THEN "abort" ELSE result
         settled == [book EXCEPT !.claims[id].io = result,
                                 !.claims[id].reply = reply]
     IN /\ claim.io = "pending"
        /\ IF claim.released \/ result = "rejected"
           THEN book' = Refund([settled EXCEPT !.claims[id].released = TRUE],
                               id, claim.released)
           ELSE book' = settled

Next == \E id \in Requests :
          \/ Submit(id)
          \/ TryRetained(id)
          \/ LeaveQueue(id, "abort")
          \/ LeaveQueue(id, "timeout")
          \/ CancelGrant(id)
          \/ Resume(id)
          \/ StartRetained(id)
          \/ DuplicateBegin(id)
          \/ Release(id)
          \/ AbortRead(id)
          \/ Settle(id, "fulfilled")
          \/ Settle(id, "rejected")

InTransit(claim) == claim.owner = "granted"
Pending(claim) == claim.io = "pending"
Outstanding(claim) == Leased(claim) /\ (~claim.released \/ Pending(claim))
Retired(claim) == Leased(claim) /\ claim.released /\ Pending(claim)

RECURSIVE Bytes(_)
Bytes(ids) ==
  IF ids = {} THEN 0
  ELSE LET id == CHOOSE candidate \in ids : TRUE
       IN Extents[id] + Bytes(ids \ {id})

InTransitIds == {id \in Requests : InTransit(book.claims[id])}
OutstandingIds == {id \in Requests : Outstanding(book.claims[id])}
RetiredIds == {id \in Requests : Retired(book.claims[id])}

CreditConservation == book.live = Bytes(InTransitIds) + Bytes(OutstandingIds)
Retirement == /\ RetiredIds \subseteq OutstandingIds
              /\ book.retired = Bytes(RetiredIds)
              /\ 0 <= book.retired /\ book.retired <= book.live
CapacityBound == 0 <= book.live /\ book.live <= Capacity

OneRefund ==
  \A id \in Requests :
    LET claim == book.claims[id]
        expected == IF id \in InTransitIds \cup OutstandingIds THEN 1 ELSE 0
    IN /\ claim.refunds \in 0..claim.debits
       /\ claim.debits \in 0..1
       /\ claim.debits - claim.refunds = expected

QueueContract ==
  LET queuedIds == {book.queue[index] : index \in DOMAIN book.queue}
  IN /\ queuedIds = {id \in Requests : book.claims[id].owner = "queued"}
     /\ Cardinality(queuedIds) = Len(book.queue)
     /\ Len(book.queue) <= MaxWaiters
     /\ IF Len(book.queue) > 0 THEN ~Fits(book, Head(book.queue)) ELSE TRUE

AdmissionOrder ==
  /\ \A later \in DOMAIN book.queue :
       book'.claims[book.queue[later]].owner = "granted" =>
         \A earlier \in 1..(later - 1) :
           book'.claims[book.queue[earlier]].owner \in {"granted", "denied"}
  /\ Len(book.queue) > 0 =>
       \A id \in Requests :
         book.claims[id].owner = "new" =>
           book'.claims[id].owner \notin {"granted", "retained"}

ReplyStable ==
  \A id \in Requests :
    book.claims[id].reply # "open" =>
      book'.claims[id].reply = book.claims[id].reply

ObservableTransitions == [][AdmissionOrder /\ ReplyStable]_book
=============================================================================
