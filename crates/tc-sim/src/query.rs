//! Live queries: a game's read-only functions that clients subscribe to
//! (`Subscribe`), kept current by the sync layer (`crate::sync`).
//!
//! A query is a plain function of a [`QueryCtx`] and its arguments
//! ([`Query::new`]). It reads the game through the context and records
//! what it read: [`QueryCtx::read`] a change key the game marks
//! ([`Cx::mark`](crate::Cx::mark)), [`QueryCtx::body`] a player's body
//! (unlogged, see [`Game::Body`]), [`QueryCtx::valid_until`] a time its
//! result runs out, [`QueryCtx::volatile`] state nothing marks. The sync
//! layer reruns it only when one of those changed; a rerun whose result is
//! unchanged sends nothing. A query that reads state without recording it
//! goes stale: debug builds rerun clean queries on every flush and count
//! each result that changed untracked
//! ([`SyncStats::tracking_misses`](crate::SyncStats)).
//!
//! **Views.** A query whose answer depends on what the asker may see (a
//! position inside or outside its interest, say) names a view function
//! ([`Query::with_view`]): from the asker ([`ViewCx`]: its player and its
//! connection's interest) and the arguments, a small number of the game's
//! choosing, which the run reads back ([`QueryCtx::view`]). Subscriptions
//! are shared per view, and when a connection's interest changes, each of
//! its subscriptions whose view changed moves to the shared entry for its
//! new view and gets the difference from what it was last sent. Queries
//! without one run in view 0.
//!
//! The context's [`QueryCtx::game`] and [`QueryCtx::time`] record nothing:
//! a game wraps its reads in accessors that call [`QueryCtx::read`] first,
//! as the entity stream's [`Game::entities`] does too.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use tc_wire::Wire;
use tc_wire::schema::{Field, QueryDef, Schema, SchemaBuilder, TypeKind, TypeRef};

use crate::game::{Game, InterestOf, PlayerId};

/// One thing a query or an entity stream read.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Key<C> {
    /// A change key the game marks ([`Game::Change`]).
    Game(C),
    /// A player's body: changes with every input it takes.
    Body(PlayerId),
}

/// What one run read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reads<C: Ord> {
    /// The tracked state it read.
    pub keys: BTreeSet<Key<C>>,
    /// Its result holds until this time (in steps), and reruns then.
    pub valid_until: Option<u64>,
    /// It read untracked state: rerun whenever anything changed (a log
    /// entry, a mark, a body).
    pub volatile: bool,
}

impl<C: Ord> Default for Reads<C> {
    fn default() -> Self {
        Reads {
            keys: BTreeSet::new(),
            valid_until: None,
            volatile: false,
        }
    }
}

impl<C: Ord> Reads<C> {
    /// True if a run that read this must run again: a key changed, it
    /// expired by `time`, or it is volatile and anything changed.
    pub(crate) fn stale(&self, changed: &BTreeSet<Key<C>>, any: bool, time: u64) -> bool {
        (self.volatile && any)
            || self.valid_until.is_some_and(|t| t <= time)
            || self.keys.iter().any(|k| changed.contains(k))
    }
}

/// What a query (or [`Game::entities`]) runs with: the game, read through
/// accessors that record what they read, and the asking player for a
/// per-player query.
pub struct QueryCtx<'a, G: Game> {
    game: &'a G,
    player: Option<PlayerId>,
    view: u32,
    time: u64,
    bodies: &'a BTreeMap<PlayerId, G::Body>,
    reads: RefCell<Reads<G::Change>>,
}

impl<'a, G: Game> QueryCtx<'a, G> {
    pub(crate) fn new(
        game: &'a G,
        player: Option<PlayerId>,
        view: u32,
        time: u64,
        bodies: &'a BTreeMap<PlayerId, G::Body>,
    ) -> QueryCtx<'a, G> {
        QueryCtx {
            game,
            player,
            view,
            time,
            bodies,
            reads: RefCell::new(Reads::default()),
        }
    }

    /// The game. Reading it records nothing: call [`QueryCtx::read`] for
    /// what the result depends on.
    pub fn game(&self) -> &'a G {
        self.game
    }

    /// The asking player: `Some` for a per-player query, and for the
    /// entity stream of a player (an observer's is `None`).
    pub fn player(&self) -> Option<PlayerId> {
        self.player
    }

    /// The view this run answers in ([`Query::with_view`]); 0 for a query
    /// without a view function, and for the entity stream.
    pub fn view(&self) -> u32 {
        self.view
    }

    /// The current time, in steps. Records nothing: a result that
    /// depends on it says until when it holds ([`QueryCtx::valid_until`]).
    pub fn time(&self) -> u64 {
        self.time
    }

    /// Records that the result depends on what `key` marks.
    pub fn read(&self, key: G::Change) {
        self.reads.borrow_mut().keys.insert(Key::Game(key));
    }

    /// `player`'s body, if it is present; the result depends on it.
    pub fn body(&self, player: PlayerId) -> Option<&'a G::Body> {
        self.reads.borrow_mut().keys.insert(Key::Body(player));
        self.bodies.get(&player)
    }

    /// The result holds until `time` (the earliest of every call).
    pub fn valid_until(&self, time: u64) {
        let mut reads = self.reads.borrow_mut();
        reads.valid_until = Some(reads.valid_until.map_or(time, |t| t.min(time)));
    }

    /// The result read state nothing marks: rerun it whenever anything
    /// changed.
    pub fn volatile(&self) {
        self.reads.borrow_mut().volatile = true;
    }

    pub(crate) fn into_reads(self) -> Reads<G::Change> {
        self.reads.into_inner()
    }
}

type Run<G> = dyn Fn(&QueryCtx<'_, G>, &[u8]) -> Result<Vec<u8>, String> + Send + Sync;
type Describe = dyn Fn(&mut SchemaBuilder) -> QueryDef + Send + Sync;
type ViewOf<G> = dyn Fn(&ViewCx<'_, G>, &[u8]) -> u32 + Send + Sync;

/// Who asks a query, for its view function ([`Query::with_view`]).
pub struct ViewCx<'a, G: Game> {
    pub(crate) game: &'a G,
    pub(crate) player: Option<PlayerId>,
    pub(crate) interest: Option<&'a InterestOf<G>>,
}

impl<'a, G: Game> ViewCx<'a, G> {
    /// The game. A view should depend on the asker and the arguments:
    /// it is worked out again only when the asker's interest changes (and
    /// at a reload), not when the game does.
    pub fn game(&self) -> &'a G {
        self.game
    }

    /// The asking player; `None` for an observer.
    pub fn player(&self) -> Option<PlayerId> {
        self.player
    }

    /// The asking connection's interest: its entity stream's (set by
    /// `SetInterest` or following its body, [`Game::follow`]), or `None`
    /// before it has one.
    pub fn interest(&self) -> Option<&'a InterestOf<G>> {
        self.interest
    }
}

/// A live query a game serves ([`Game::queries`]).
pub struct Query<G: Game> {
    pub(crate) name: &'static str,
    pub(crate) player: bool,
    pub(crate) describe: Box<Describe>,
    pub(crate) check: fn(&[u8]) -> Result<(), String>,
    pub(crate) run: Box<Run<G>>,
    pub(crate) view: Option<Box<ViewOf<G>>>,
}

impl<G: Game> std::fmt::Debug for Query<G> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Query")
            .field("name", &self.name)
            .field("player", &self.player)
            .finish_non_exhaustive()
    }
}

impl<G: Game> Query<G> {
    /// Query `name` (snake_case): `run` answers arguments `A`, a struct
    /// whose fields are the query's arguments (`tc_net::Empty` for none),
    /// with an `R` or an error (sent as `QueryFailed`). A `player` query's
    /// result depends on who asks; it is shared only per player, and an
    /// observer can't subscribe to it.
    pub fn new<A, R>(
        name: &'static str,
        doc: &'static str,
        player: bool,
        run: impl Fn(&QueryCtx<'_, G>, A) -> Result<R, String> + Send + Sync + 'static,
    ) -> Query<G>
    where
        A: Wire + 'static,
        R: Wire + 'static,
    {
        Query {
            name,
            player,
            describe: Box::new(move |b| QueryDef {
                name,
                doc,
                player,
                args: args_of::<A>(b),
                result: b.describe::<R>(),
            }),
            check: |bytes| A::from_bytes(bytes).map(drop).map_err(bad_args),
            run: Box::new(move |cx, bytes| {
                let args = A::from_bytes(bytes).map_err(bad_args)?;
                run(cx, args).map(|r| r.to_bytes())
            }),
            view: None,
        }
    }

    /// Answers in views (see [`ViewCx`]): `view` gives, from
    /// the asker and the arguments `A` (the query's own), the view a run
    /// answers in ([`QueryCtx::view`]), a number of the game's choosing.
    /// Subscriptions are shared per view; a connection's subscriptions
    /// move between views as its interest changes.
    #[must_use]
    pub fn with_view<A: Wire + 'static>(
        mut self,
        view: impl Fn(&ViewCx<'_, G>, A) -> u32 + Send + Sync + 'static,
    ) -> Query<G> {
        self.view = Some(Box::new(move |cx, bytes| {
            A::from_bytes(bytes).map_or(0, |args| view(cx, args))
        }));
        self
    }

    /// The view `cx` asks `args` in: 0 without a view function.
    pub(crate) fn view_of(&self, cx: &ViewCx<'_, G>, args: &[u8]) -> u32 {
        self.view.as_ref().map_or(0, |view| view(cx, args))
    }

    /// Its wire name.
    pub fn name(&self) -> &'static str {
        self.name
    }
}

fn bad_args(e: tc_wire::DecodeError) -> String {
    format!("bad arguments: {e}")
}

/// The fields of `A`, a struct, with the named types they use described
/// into `b` (`A` itself is not: a query's arguments are its fields).
fn args_of<A: Wire>(b: &mut SchemaBuilder) -> Vec<Field> {
    let (schema, ty) = Schema::for_type::<A>();
    let TypeRef::Named(name) = &ty else {
        panic!("a query's arguments are a named struct, not {ty:?}");
    };
    let Some(TypeKind::Struct(fields)) = schema.get(name).map(|d| d.kind.clone()) else {
        panic!("a query's arguments are a struct, not {name}");
    };
    for def in schema.types().iter().filter(|d| d.name != *name) {
        b.define(def.name, def.rust_path, def.doc, |_| def.kind.clone());
    }
    fields
}

/// `G`'s schema: tc-net's envelope for its protocol, its entity view
/// ([`Game::View`], a root) and its queries (a query's arguments are its
/// struct's fields) ([`Game::queries`]), and whatever
/// `more` adds. What [`Game::schema`] returns unless the game says
/// otherwise.
///
/// # Panics
///
/// If the schema is invalid (a game bug: two queries of one name, say).
pub fn schema_of<G: Game>(more: impl FnOnce(&mut SchemaBuilder)) -> Schema {
    let mut b = tc_net::schema_builder::<G::Protocol>();
    b.root::<G::View>();
    for q in G::queries() {
        let def = (q.describe)(&mut b);
        b.query(def);
    }
    more(&mut b);
    b.finish().expect("the game's schema is valid")
}

/// The queries a sim serves, by name.
pub(crate) type Registry<G> = BTreeMap<&'static str, Arc<Query<G>>>;

pub(crate) fn registry<G: Game>() -> Registry<G> {
    G::queries()
        .into_iter()
        .map(|q| (q.name, Arc::new(q)))
        .collect()
}
