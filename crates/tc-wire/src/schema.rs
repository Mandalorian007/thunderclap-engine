//! Schema descriptions of protocol types.
//!
//! Every [`Wire`] type describes itself into a [`SchemaBuilder`].
//! The finished [`Schema`] drives the TypeScript generator (`tc-tsgen`), the
//! schema hash, and the generic diff ([`crate::diff`]). Besides message
//! types, a schema lists the live queries ([`QueryDef`]): their names,
//! argument fields, and result types. A game's server registers them.
//!
//! The canonical text and hash match `src/net/schema.ts` byte for byte
//! (`tests/parity.rs` checks the shared vectors).

use std::collections::BTreeMap;
use std::fmt::{self, Write as _};

use crate::Wire;

/// A reference to a type from a field, variant, or another type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeRef {
    /// `bool`
    Bool,
    /// `u8`
    U8,
    /// `u16`
    U16,
    /// `u32`
    U32,
    /// `u64`
    U64,
    /// `i32`
    I32,
    /// `i64`
    I64,
    /// [`crate::Fixed`]: signed 32.32 fixed point, carried as its raw
    /// `i64` bits.
    Fixed,
    /// `String`
    String,
    /// [`crate::Bytes`]: raw bytes, encoded like `Vec<u8>`.
    Bytes,
    /// `Vec<T>`
    Vec(Box<TypeRef>),
    /// `BTreeMap<K, V>`: a keyed map whose keys are integers, strings, or
    /// newtypes of them.
    Map(Box<TypeRef>, Box<TypeRef>),
    /// `Option<T>`
    Option(Box<TypeRef>),
    /// A named struct, newtype, or enum defined in the schema.
    Named(&'static str),
}

impl fmt::Display for TypeRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            TypeRef::Bool => f.write_str("bool"),
            TypeRef::U8 => f.write_str("u8"),
            TypeRef::U16 => f.write_str("u16"),
            TypeRef::U32 => f.write_str("u32"),
            TypeRef::U64 => f.write_str("u64"),
            TypeRef::I32 => f.write_str("i32"),
            TypeRef::I64 => f.write_str("i64"),
            TypeRef::Fixed => f.write_str("Fixed"),
            TypeRef::String => f.write_str("String"),
            TypeRef::Bytes => f.write_str("Bytes"),
            TypeRef::Vec(inner) => write!(f, "Vec<{inner}>"),
            TypeRef::Map(key, value) => write!(f, "Map<{key}, {value}>"),
            TypeRef::Option(inner) => write!(f, "Option<{inner}>"),
            TypeRef::Named(name) => f.write_str(name),
        }
    }
}

/// A named field of a struct or struct-like variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    /// The Rust field name (snake_case).
    pub name: &'static str,
    /// Doc comment text; not part of the schema hash.
    pub doc: &'static str,
    /// The field's type.
    pub ty: TypeRef,
}

impl Field {
    /// A field description.
    pub fn new(name: &'static str, doc: &'static str, ty: TypeRef) -> Self {
        Self { name, doc, ty }
    }
}

/// One enum variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Variant {
    /// The Rust variant name (PascalCase).
    pub name: &'static str,
    /// Doc comment text; not part of the schema hash.
    pub doc: &'static str,
    /// What the variant carries.
    pub fields: VariantFields,
}

/// The payload of a [`Variant`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VariantFields {
    /// No payload.
    Unit,
    /// Named fields.
    Named(Vec<Field>),
    /// A single unnamed value.
    Newtype(TypeRef),
}

impl Variant {
    /// A variant without a payload.
    pub fn unit(name: &'static str, doc: &'static str) -> Self {
        Self {
            name,
            doc,
            fields: VariantFields::Unit,
        }
    }

    /// A variant with named fields.
    pub fn named(name: &'static str, doc: &'static str, fields: Vec<Field>) -> Self {
        Self {
            name,
            doc,
            fields: VariantFields::Named(fields),
        }
    }

    /// A variant wrapping one value.
    pub fn newtype(name: &'static str, doc: &'static str, ty: TypeRef) -> Self {
        Self {
            name,
            doc,
            fields: VariantFields::Newtype(ty),
        }
    }
}

/// The shape of a named type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TypeKind {
    /// A struct with named fields.
    Struct(Vec<Field>),
    /// A single-field tuple struct, encoded as its inner value.
    Newtype(TypeRef),
    /// An enum.
    Enum(Vec<Variant>),
}

/// A named type in the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TypeDef {
    /// The type's name as it appears on the wire schema and in TypeScript.
    pub name: &'static str,
    /// The full Rust path, used only to detect two types with the same name.
    pub rust_path: &'static str,
    /// Doc comment text; not part of the schema hash.
    pub doc: &'static str,
    /// The type's shape.
    pub kind: TypeKind,
}

/// A live query: its name, argument fields, and result type.
///
/// Arguments are encoded like a struct's fields (in order, no prefix), as
/// the argument bytes of a subscribe message; a query without arguments
/// sends no bytes. Results are encoded as `result`, carried as bytes in a
/// resync and patched by updates ([`crate::diff`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryDef {
    /// The wire name (snake_case); TypeScript calls it by its camelCase.
    pub name: &'static str,
    /// Doc comment text; not part of the schema hash.
    pub doc: &'static str,
    /// True if the result depends on the asking player (their inventory,
    /// their position); such results are shared only per player. Not part
    /// of the schema hash: it changes no encoding.
    pub player: bool,
    /// The arguments, in order.
    pub args: Vec<Field>,
    /// The result type.
    pub result: TypeRef,
}

/// A reference to `T`, described into a scratch builder: what a generic
/// type's derive names its arguments by. Called by `#[derive(Wire)]`.
#[doc(hidden)]
pub fn type_ref_of<T: Wire>() -> TypeRef {
    T::describe(&mut SchemaBuilder::new())
}

/// The schema name of a generic type's instantiation: `base` followed by
/// each argument's name, PascalCase (`Page` of `Item` is `PageItem`;
/// `Vec<u8>` is `VecU8`, `Option<String>` is `OptionString`,
/// `Map<u32, Bytes>` is `MapU32Bytes`). Names are interned, so each
/// distinct one is allocated once. Called by `#[derive(Wire)]`.
pub fn generic_name(base: &str, args: &[TypeRef]) -> &'static str {
    use std::collections::BTreeSet;
    use std::sync::{Mutex, OnceLock};
    fn part(out: &mut String, ty: &TypeRef) {
        match ty {
            TypeRef::Vec(inner) => {
                out.push_str("Vec");
                part(out, inner);
            }
            TypeRef::Option(inner) => {
                out.push_str("Option");
                part(out, inner);
            }
            TypeRef::Map(key, value) => {
                out.push_str("Map");
                part(out, key);
                part(out, value);
            }
            TypeRef::Named(name) => out.push_str(name),
            scalar => {
                let text = scalar.to_string();
                let mut chars = text.chars();
                if let Some(first) = chars.next() {
                    out.extend(first.to_uppercase());
                    out.push_str(chars.as_str());
                }
            }
        }
    }
    static NAMES: OnceLock<Mutex<BTreeSet<&'static str>>> = OnceLock::new();
    let mut name = base.to_string();
    for arg in args {
        part(&mut name, arg);
    }
    let mut names = NAMES
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(&interned) = names.get(name.as_str()) {
        return interned;
    }
    let interned: &'static str = Box::leak(name.into_boxed_str());
    names.insert(interned);
    interned
}

/// Collects type descriptions, starting from one or more root types.
#[derive(Debug)]
pub struct SchemaBuilder {
    header: &'static str,
    roots: Vec<&'static str>,
    types: Vec<Option<TypeDef>>,
    index: BTreeMap<&'static str, (usize, &'static str)>,
    queries: Vec<QueryDef>,
}

impl Default for SchemaBuilder {
    fn default() -> Self {
        Self {
            header: WIRE_HEADER,
            roots: Vec::new(),
            types: Vec::new(),
            index: BTreeMap::new(),
            queries: Vec::new(),
        }
    }
}

impl SchemaBuilder {
    /// An empty builder, with the engine's header line ([`WIRE_HEADER`]).
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the canonical text's first line (default [`WIRE_HEADER`]). A
    /// game that shipped its own header keeps its hashes by passing it.
    pub fn header(&mut self, header: &'static str) -> &mut Self {
        self.header = header;
        self
    }

    /// Adds `T` (a named type) as a root of the schema.
    pub fn root<T: Wire>(&mut self) -> &mut Self {
        match T::describe(self) {
            TypeRef::Named(name) => {
                if !self.roots.contains(&name) {
                    self.roots.push(name);
                }
            }
            other => panic!("schema roots must be named types, not `{other}`"),
        }
        self
    }

    /// Registers a named type, building its description the first time it is
    /// seen. Called by `#[derive(Wire)]`.
    ///
    /// # Panics
    ///
    /// If two different Rust types share the same name.
    pub fn define(
        &mut self,
        name: &'static str,
        rust_path: &'static str,
        doc: &'static str,
        build: impl FnOnce(&mut SchemaBuilder) -> TypeKind,
    ) -> TypeRef {
        if let Some(&(_, existing)) = self.index.get(name) {
            assert!(
                existing == rust_path,
                "two protocol types are named `{name}`: `{existing}` and `{rust_path}`; \
                 protocol type names must be unique"
            );
            return TypeRef::Named(name);
        }
        let slot = self.types.len();
        self.types.push(None);
        self.index.insert(name, (slot, rust_path));
        let kind = build(self);
        self.types[slot] = Some(TypeDef {
            name,
            rust_path,
            doc,
            kind,
        });
        TypeRef::Named(name)
    }

    /// Adds a live query. Its argument and result types must already be
    /// described into this builder (see [`SchemaBuilder::describe`]).
    pub fn query(&mut self, def: QueryDef) -> &mut Self {
        self.queries.push(def);
        self
    }

    /// Describes `T` into this builder and returns its reference.
    pub fn describe<T: Wire>(&mut self) -> TypeRef {
        T::describe(self)
    }

    /// Finishes the schema and checks it.
    pub fn finish(self) -> Result<Schema, String> {
        let types = self
            .types
            .into_iter()
            .map(|t| t.expect("every started definition is finished"))
            .collect();
        Schema::from_parts(self.header, self.roots, types, self.queries)
    }
}

/// A complete, checked set of protocol types.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Schema {
    header: &'static str,
    roots: Vec<&'static str>,
    types: Vec<TypeDef>,
    queries: Vec<QueryDef>,
}

/// Version of the encoding rules themselves; part of the hashed text.
/// 2: maps, bytes, and live queries.
pub const WIRE_FORMAT: u32 = 2;

/// The canonical text's default first line: `thunderclap-wire 2`. The same
/// as `WIRE_HEADER` in `src/net/schema.ts`.
pub const WIRE_HEADER: &str = "thunderclap-wire 2";

impl Schema {
    /// A schema from its parts, checked: for tools that build a schema from
    /// data rather than from `Wire` types. `types` must hold every named
    /// type the roots, queries and other types use, each once, in the order
    /// the canonical text lists them (discovery order, for a hash that
    /// matches a derived schema).
    pub fn from_parts(
        header: &'static str,
        roots: Vec<&'static str>,
        types: Vec<TypeDef>,
        queries: Vec<QueryDef>,
    ) -> Result<Schema, String> {
        if header.is_empty() || header.contains('\n') {
            return Err("the header is one non-empty line".into());
        }
        let schema = Schema {
            header,
            roots,
            types,
            queries,
        };
        schema.validate()?;
        Ok(schema)
    }

    /// The canonical text's first line.
    pub fn header(&self) -> &'static str {
        self.header
    }

    /// A schema holding just `T` and the types it uses, and `T`'s reference
    /// (which need not be a named type). For tests and tools.
    ///
    /// # Panics
    ///
    /// If `T`'s description is invalid.
    pub fn for_type<T: Wire>() -> (Schema, TypeRef) {
        let mut builder = SchemaBuilder::new();
        let ty = T::describe(&mut builder);
        let schema = builder.finish().expect("the type's schema is valid");
        schema
            .check_ref("type", &ty)
            .expect("the type's schema is valid");
        (schema, ty)
    }

    /// Root type names, in the order they were added.
    pub fn roots(&self) -> &[&'static str] {
        &self.roots
    }

    /// Every named type, in order of discovery from the roots.
    pub fn types(&self) -> &[TypeDef] {
        &self.types
    }

    /// The live queries, in registration order.
    pub fn queries(&self) -> &[QueryDef] {
        &self.queries
    }

    /// Looks up a live query by its wire name.
    pub fn query(&self, name: &str) -> Option<&QueryDef> {
        self.queries.iter().find(|q| q.name == name)
    }

    /// Looks up a named type.
    pub fn get(&self, name: &str) -> Option<&TypeDef> {
        self.types.iter().find(|t| t.name == name)
    }

    /// Follows newtypes until reaching a non-newtype reference.
    pub fn resolve<'a>(&'a self, mut ty: &'a TypeRef) -> &'a TypeRef {
        while let TypeRef::Named(name) = ty {
            match self.get(name).map(|t| &t.kind) {
                Some(TypeKind::Newtype(inner)) => ty = inner,
                _ => break,
            }
        }
        ty
    }

    /// The canonical text the schema hash is computed from: every name, type,
    /// field, and variant in order. Doc comments are excluded.
    pub fn canonical_text(&self) -> String {
        let mut out = String::new();
        let _ = writeln!(out, "{}", self.header);
        for root in &self.roots {
            let _ = writeln!(out, "root {root}");
        }
        for query in &self.queries {
            let _ = writeln!(
                out,
                "query {}{} -> {}",
                query.name,
                render_args(&query.args),
                query.result
            );
        }
        for def in &self.types {
            match &def.kind {
                TypeKind::Struct(fields) => {
                    let _ = writeln!(out, "struct {} {}", def.name, render_fields(fields));
                }
                TypeKind::Newtype(inner) => {
                    let _ = writeln!(out, "newtype {}({inner})", def.name);
                }
                TypeKind::Enum(variants) => {
                    let _ = writeln!(out, "enum {} {{", def.name);
                    for variant in variants {
                        let _ = match &variant.fields {
                            VariantFields::Unit => writeln!(out, "  {}", variant.name),
                            VariantFields::Named(fields) => {
                                writeln!(out, "  {} {}", variant.name, render_fields(fields))
                            }
                            VariantFields::Newtype(inner) => {
                                writeln!(out, "  {}({inner})", variant.name)
                            }
                        };
                    }
                    out.push_str("}\n");
                }
            }
        }
        out
    }

    /// The schema hash: 16 lowercase hex digits of the stable hash of
    /// [`canonical_text`](Self::canonical_text).
    pub fn hash(&self) -> String {
        let mut hasher = crate::hash::StableHasher::new();
        hasher.write_str(&self.canonical_text());
        format!("{:016x}", hasher.finish())
    }

    fn validate(&self) -> Result<(), String> {
        let mut type_names = std::collections::BTreeSet::new();
        for def in &self.types {
            if !type_names.insert(def.name) {
                return Err(format!("two types are named `{}`", def.name));
            }
        }
        for root in &self.roots {
            if !type_names.contains(root) {
                return Err(format!("root `{root}` is not a named type of the schema"));
            }
        }
        let mut names = std::collections::BTreeSet::new();
        for query in &self.queries {
            let ident =
                query.name.bytes().enumerate().all(|(i, b)| {
                    b.is_ascii_lowercase() || b == b'_' || (i > 0 && b.is_ascii_digit())
                });
            if query.name.is_empty() || !ident {
                return Err(format!(
                    "query `{}`: names are snake_case identifiers",
                    query.name
                ));
            }
            if !names.insert(query.name) {
                return Err(format!("two queries are named `{}`", query.name));
            }
            for f in &query.args {
                self.check_ref(&format!("query {}({})", query.name, f.name), &f.ty)?;
            }
            self.check_ref(&format!("query {} result", query.name), &query.result)?;
        }
        for def in &self.types {
            let check = |context: String, ty: &TypeRef| self.check_ref(&context, ty);
            match &def.kind {
                TypeKind::Struct(fields) => {
                    for f in fields {
                        check(format!("{}.{}", def.name, f.name), &f.ty)?;
                    }
                }
                TypeKind::Newtype(inner) => check(def.name.to_string(), inner)?,
                TypeKind::Enum(variants) => {
                    for v in variants {
                        match &v.fields {
                            VariantFields::Unit => {}
                            VariantFields::Named(fields) => {
                                for f in fields {
                                    check(format!("{}::{}.{}", def.name, v.name, f.name), &f.ty)?;
                                }
                            }
                            VariantFields::Newtype(inner) => {
                                check(format!("{}::{}", def.name, v.name), inner)?;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    fn check_ref(&self, context: &str, ty: &TypeRef) -> Result<(), String> {
        match ty {
            TypeRef::Vec(inner) => self.check_ref(context, inner),
            TypeRef::Map(key, value) => {
                match self.resolve(key) {
                    TypeRef::U8
                    | TypeRef::U16
                    | TypeRef::U32
                    | TypeRef::U64
                    | TypeRef::I32
                    | TypeRef::I64
                    | TypeRef::String => {}
                    _ => {
                        return Err(format!(
                            "{context}: map key `{key}` must be an integer, a string, or a \
                             newtype of one, so every language orders keys the same way"
                        ));
                    }
                }
                self.check_ref(context, value)
            }
            TypeRef::Option(inner) => {
                if let TypeRef::Option(_) = self.resolve(inner) {
                    return Err(format!(
                        "{context}: `{ty}` nests options, which TypeScript cannot tell apart \
                         (`T | null | null`); use an enum"
                    ));
                }
                self.check_ref(context, inner)
            }
            TypeRef::Named(name) => match self.get(name) {
                Some(_) => Ok(()),
                None => Err(format!("{context}: unknown type `{name}`")),
            },
            _ => Ok(()),
        }
    }
}

fn render_args(fields: &[Field]) -> String {
    let inner: Vec<String> = fields
        .iter()
        .map(|f| format!("{}: {}", f.name, f.ty))
        .collect();
    format!("({})", inner.join(", "))
}

fn render_fields(fields: &[Field]) -> String {
    let inner: Vec<String> = fields
        .iter()
        .map(|f| format!("{}: {}", f.name, f.ty))
        .collect();
    format!("{{ {} }}", inner.join(", "))
}
