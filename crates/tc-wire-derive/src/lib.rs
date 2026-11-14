//! `#[derive(Wire)]`: gives a type its `tc_wire::Wire` codec and its
//! schema description. See `tc_wire::wire` for the format. Re-exported as
//! `tc_wire::Wire`; depend on `tc-wire`, not on this crate.

use proc_macro::TokenStream;
use proc_macro2::TokenStream as TokenStream2;
use quote::quote;
use syn::ext::IdentExt;
use syn::{Attribute, Data, DeriveInput, Expr, Fields, GenericParam, Ident, Lit, Meta, Type};

/// Derives `tc_wire::Wire` for a protocol type.
///
/// Generic types are supported: each type parameter must itself be `Wire`
/// (the derive adds the bound), and each instantiation is its own schema
/// type, named by the type followed by its arguments' names
/// (`Page<Item>` is `PageItem`, `Pair<u8, Vec<String>>` is
/// `PairU8VecString`; see `tc_wire::schema::generic_name`). Lifetime and
/// const parameters are not supported.
///
/// Supported shapes:
/// - structs with named fields (at least one),
/// - newtypes: tuple structs with exactly one field (encoded as the inner value),
/// - enums whose variants are unit, named-field, or single-field tuple variants.
///
/// Fields encode in declaration order; enum variants encode as their
/// declaration index. Doc comments are carried into the schema (and the
/// generated TypeScript) but do not affect the schema hash.
#[proc_macro_derive(Wire)]
pub fn derive_wire(input: TokenStream) -> TokenStream {
    let input = syn::parse_macro_input!(input as DeriveInput);
    expand(&input)
        .unwrap_or_else(syn::Error::into_compile_error)
        .into()
}

fn expand(input: &DeriveInput) -> syn::Result<TokenStream2> {
    let name = &input.ident;
    let type_name = name.unraw().to_string();
    let mut generics = input.generics.clone();
    let mut params = Vec::new();
    for param in &input.generics.params {
        match param {
            GenericParam::Type(t) => params.push(t.ident.clone()),
            GenericParam::Lifetime(_) | GenericParam::Const(_) => {
                return Err(syn::Error::new_spanned(
                    param,
                    "#[derive(Wire)] supports type parameters only: a wire value owns its data \
                     and its schema names its types",
                ));
            }
        }
    }
    {
        let where_clause = generics.make_where_clause();
        for p in &params {
            where_clause
                .predicates
                .push(syn::parse_quote!(#p: ::tc_wire::Wire));
        }
    }
    // The schema name: the type's own for a concrete type, the type's
    // followed by its arguments' for a generic one.
    let schema_name = if params.is_empty() {
        quote! { #type_name }
    } else {
        quote! {
            ::tc_wire::schema::generic_name(
                #type_name,
                &[ #( ::tc_wire::schema::type_ref_of::<#params>() ),* ],
            )
        }
    };
    let body = match &input.data {
        Data::Struct(data) => expand_struct(name, &data.fields)?,
        Data::Enum(data) => {
            let variants: Vec<_> = data.variants.iter().collect();
            expand_enum(name, &schema_name, &variants)?
        }
        Data::Union(data) => {
            return Err(syn::Error::new_spanned(
                data.union_token,
                "#[derive(Wire)] does not support unions; use an enum",
            ));
        }
    };
    let Body {
        encode,
        decode,
        describe,
    } = body;
    let doc = doc_string(&input.attrs);
    let (impl_generics, ty_generics, where_clause) = generics.split_for_impl();
    Ok(quote! {
        #[automatically_derived]
        impl #impl_generics ::tc_wire::Wire for #name #ty_generics #where_clause {
            fn encode(&self, w: &mut ::tc_wire::Writer) {
                #encode
            }

            fn decode(
                r: &mut ::tc_wire::Reader<'_>,
            ) -> ::core::result::Result<Self, ::tc_wire::DecodeError> {
                #decode
            }

            fn describe(s: &mut ::tc_wire::SchemaBuilder) -> ::tc_wire::TypeRef {
                s.define(
                    #schema_name,
                    ::core::any::type_name::<Self>(),
                    #doc,
                    |s| #describe,
                )
            }
        }
    })
}

struct Body {
    encode: TokenStream2,
    decode: TokenStream2,
    describe: TokenStream2,
}

fn expand_struct(name: &Ident, fields: &Fields) -> syn::Result<Body> {
    match fields {
        Fields::Named(named) => {
            if named.named.is_empty() {
                return Err(syn::Error::new_spanned(
                    name,
                    "#[derive(Wire)] needs at least one field: every wire value must encode \
                     to at least one byte",
                ));
            }
            let named = named_fields(fields)?;
            let idents: Vec<_> = named.iter().map(|f| f.ident).collect();
            let types: Vec<_> = named.iter().map(|f| f.ty).collect();
            let describe_fields = describe_fields(&named);
            Ok(Body {
                encode: quote! {
                    #( ::tc_wire::Wire::encode(&self.#idents, w); )*
                },
                decode: quote! {
                    ::core::result::Result::Ok(Self {
                        #( #idents: <#types as ::tc_wire::Wire>::decode(r)?, )*
                    })
                },
                describe: quote! {
                    ::tc_wire::TypeKind::Struct(#describe_fields)
                },
            })
        }
        Fields::Unnamed(unnamed) => {
            let [field] = single_field(unnamed, || {
                format!(
                    "#[derive(Wire)] supports tuple structs with exactly one field (a newtype); \
                     `{name}` has {}. Use named fields instead",
                    unnamed.unnamed.len()
                )
            })?;
            reject_field_default(field)?;
            let ty = &field.ty;
            Ok(Body {
                encode: quote! { ::tc_wire::Wire::encode(&self.0, w); },
                decode: quote! {
                    ::core::result::Result::Ok(Self(<#ty as ::tc_wire::Wire>::decode(r)?))
                },
                describe: quote! {
                    ::tc_wire::TypeKind::Newtype(<#ty as ::tc_wire::Wire>::describe(s))
                },
            })
        }
        Fields::Unit => Err(syn::Error::new_spanned(
            name,
            "#[derive(Wire)] does not support unit structs: every wire value must encode to at \
             least one byte. Use a unit variant of an enum instead",
        )),
    }
}

fn expand_enum(
    name: &Ident,
    schema_name: &TokenStream2,
    variants: &[&syn::Variant],
) -> syn::Result<Body> {
    if variants.is_empty() {
        return Err(syn::Error::new_spanned(
            name,
            "#[derive(Wire)] does not support enums without variants: they cannot be decoded",
        ));
    }
    let mut errors: Option<syn::Error> = None;
    let mut encode_arms = Vec::new();
    let mut decode_arms = Vec::new();
    let mut describe_variants = Vec::new();

    for (index, variant) in variants.iter().enumerate() {
        let result = expand_variant(index as u64, variant);
        match result {
            Ok((encode, decode, describe)) => {
                encode_arms.push(encode);
                decode_arms.push(decode);
                describe_variants.push(describe);
            }
            Err(e) => match &mut errors {
                Some(all) => all.combine(e),
                None => errors = Some(e),
            },
        }
    }
    if let Some(e) = errors {
        return Err(e);
    }

    Ok(Body {
        encode: quote! {
            match self {
                #( #encode_arms )*
            }
        },
        decode: quote! {
            let at = r.position();
            match r.read_variant()? {
                #( #decode_arms )*
                index => ::core::result::Result::Err(
                    ::tc_wire::DecodeError::unknown_variant(at, #schema_name, index),
                ),
            }
        },
        describe: quote! {
            ::tc_wire::TypeKind::Enum(::std::vec![ #( #describe_variants ),* ])
        },
    })
}

fn expand_variant(
    index: u64,
    variant: &syn::Variant,
) -> syn::Result<(TokenStream2, TokenStream2, TokenStream2)> {
    if let Some((_, discriminant)) = &variant.discriminant {
        return Err(syn::Error::new_spanned(
            discriminant,
            "#[derive(Wire)] does not support explicit discriminants: variants are encoded by \
             declaration order",
        ));
    }
    let ident = &variant.ident;
    let variant_name = ident.unraw().to_string();
    let doc = doc_string(&variant.attrs);
    match &variant.fields {
        Fields::Unit => Ok((
            quote! { Self::#ident => w.write_varint(#index), },
            quote! { #index => ::core::result::Result::Ok(Self::#ident), },
            quote! { ::tc_wire::Variant::unit(#variant_name, #doc) },
        )),
        Fields::Named(_) => {
            let named = named_fields(&variant.fields)?;
            for field in &named {
                if field.name == "type" {
                    return Err(syn::Error::new_spanned(
                        field.ident,
                        "a variant field named `type` would collide with the TypeScript \
                         discriminant; rename it",
                    ));
                }
            }
            let idents: Vec<_> = named.iter().map(|f| f.ident).collect();
            let types: Vec<_> = named.iter().map(|f| f.ty).collect();
            let describe_fields = describe_fields(&named);
            Ok((
                quote! {
                    Self::#ident { #( #idents ),* } => {
                        w.write_varint(#index);
                        #( ::tc_wire::Wire::encode(#idents, w); )*
                    }
                },
                quote! {
                    #index => ::core::result::Result::Ok(Self::#ident {
                        #( #idents: <#types as ::tc_wire::Wire>::decode(r)?, )*
                    }),
                },
                quote! { ::tc_wire::Variant::named(#variant_name, #doc, #describe_fields) },
            ))
        }
        Fields::Unnamed(unnamed) => {
            let [field] = single_field(unnamed, || {
                format!(
                    "#[derive(Wire)] supports tuple variants with exactly one field; \
                     `{variant_name}` has {}. Use named fields instead",
                    unnamed.unnamed.len()
                )
            })?;
            reject_field_default(field)?;
            let ty = &field.ty;
            Ok((
                quote! {
                    Self::#ident(value) => {
                        w.write_varint(#index);
                        ::tc_wire::Wire::encode(value, w);
                    }
                },
                quote! {
                    #index => ::core::result::Result::Ok(
                        Self::#ident(<#ty as ::tc_wire::Wire>::decode(r)?),
                    ),
                },
                quote! {
                    ::tc_wire::Variant::newtype(
                        #variant_name,
                        #doc,
                        <#ty as ::tc_wire::Wire>::describe(s),
                    )
                },
            ))
        }
    }
}

struct NamedField<'a> {
    ident: &'a Ident,
    name: String,
    ty: &'a Type,
    doc: String,
}

fn named_fields(fields: &Fields) -> syn::Result<Vec<NamedField<'_>>> {
    fields
        .iter()
        .map(|field| {
            reject_field_default(field)?;
            let ident = field
                .ident
                .as_ref()
                .ok_or_else(|| syn::Error::new_spanned(field, "expected a named field"))?;
            Ok(NamedField {
                ident,
                name: ident.unraw().to_string(),
                ty: &field.ty,
                doc: doc_string(&field.attrs),
            })
        })
        .collect()
}

fn describe_fields(fields: &[NamedField<'_>]) -> TokenStream2 {
    let entries = fields.iter().map(|f| {
        let name = &f.name;
        let doc = &f.doc;
        let ty = f.ty;
        quote! {
            ::tc_wire::Field::new(#name, #doc, <#ty as ::tc_wire::Wire>::describe(s))
        }
    });
    quote! { ::std::vec![ #( #entries ),* ] }
}

fn single_field(
    fields: &syn::FieldsUnnamed,
    message: impl FnOnce() -> String,
) -> syn::Result<[&syn::Field; 1]> {
    let all: Vec<_> = fields.unnamed.iter().collect();
    match all.as_slice() {
        [one] => Ok([*one]),
        _ => Err(syn::Error::new_spanned(fields, message())),
    }
}

fn reject_field_default(field: &syn::Field) -> syn::Result<()> {
    match &field.default {
        Some((_, expr)) => Err(syn::Error::new_spanned(
            expr,
            "#[derive(Wire)] does not support default field values",
        )),
        None => Ok(()),
    }
}

/// Collects `///` doc comments into one string, one line per comment line,
/// with the conventional single leading space removed.
fn doc_string(attrs: &[Attribute]) -> String {
    let mut lines = Vec::new();
    for attr in attrs {
        if !attr.path().is_ident("doc") {
            continue;
        }
        if let Meta::NameValue(nv) = &attr.meta
            && let Expr::Lit(lit) = &nv.value
            && let Lit::Str(s) = &lit.lit
        {
            for line in s.value().split('\n') {
                lines.push(
                    line.strip_prefix(' ')
                        .unwrap_or(line)
                        .trim_end()
                        .to_string(),
                );
            }
        }
    }
    while lines.first().is_some_and(String::is_empty) {
        lines.remove(0);
    }
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand_str(src: &str) -> Result<String, String> {
        let input: DeriveInput = syn::parse_str(src).expect("test input parses");
        expand(&input)
            .map(|t| t.to_string())
            .map_err(|e| e.to_string())
    }

    fn error(src: &str) -> String {
        expand_str(src).expect_err("expected the derive to reject this input")
    }

    #[test]
    fn accepts_supported_shapes() {
        for src in [
            "struct A { x: i32, y: Vec<String> }",
            "struct Id(u64);",
            "enum E { Unit, Named { a: u8 }, Tuple(Id), Empty {} }",
        ] {
            expand_str(src).unwrap_or_else(|e| panic!("{src}: {e}"));
        }
    }

    #[test]
    fn variants_encode_by_declaration_index() {
        let out = expand_str("enum E { A, B { x: u8 }, C(u8) }").unwrap();
        assert!(
            out.contains("Self :: A => w . write_varint (0u64)"),
            "{out}"
        );
        assert!(out.contains("w . write_varint (1u64)"), "{out}");
        assert!(out.contains("w . write_varint (2u64)"), "{out}");
    }

    #[test]
    fn carries_doc_comments() {
        let out = expand_str(
            "/// A point.\n///\n/// Second paragraph.\nstruct P { /// X axis.\n x: i32 }",
        )
        .unwrap();
        assert!(out.contains(r#""A point.\n\nSecond paragraph.""#), "{out}");
        assert!(out.contains(r#""X axis.""#), "{out}");
    }

    #[test]
    fn strips_raw_identifier_prefix() {
        let out = expand_str("struct S { r#match: u8 }").unwrap();
        assert!(out.contains(r#"Field :: new ("match""#), "{out}");
    }

    #[test]
    fn generics_get_bounds_and_a_composed_name() {
        let out = expand_str("struct Page<T> { items: Vec<T>, next: Option<u32> }").unwrap();
        assert!(out.contains("T : :: tc_wire :: Wire"), "{out}");
        assert!(out.contains("generic_name (\"Page\""), "{out}");
        assert!(out.contains("type_ref_of :: < T >"), "{out}");
        expand_str("struct S where u8: Copy { x: u8 }").unwrap();
        expand_str("enum E<A, B> { L(A), R { b: B } }").unwrap();
    }

    #[test]
    fn rejects_lifetimes_and_consts() {
        assert!(error("struct S<'a> { x: &'a str }").contains("type parameters only"));
        assert!(error("struct S<const N: usize> { x: u8 }").contains("type parameters only"));
    }

    #[test]
    fn rejects_unions() {
        assert!(error("union U { a: u8 }").contains("does not support unions"));
    }

    #[test]
    fn rejects_unit_and_empty_structs() {
        assert!(error("struct S;").contains("does not support unit structs"));
        assert!(error("struct S {}").contains("needs at least one field"));
    }

    #[test]
    fn rejects_multi_field_tuples() {
        assert!(error("struct S(u8, u8);").contains("exactly one field"));
        assert!(error("struct S();").contains("exactly one field"));
        assert!(error("enum E { A(u8, u8) }").contains("tuple variants with exactly one field"));
    }

    #[test]
    fn rejects_empty_enums() {
        assert!(error("enum E {}").contains("without variants"));
    }

    #[test]
    fn rejects_discriminants() {
        assert!(error("enum E { A = 1, B }").contains("explicit discriminants"));
    }

    #[test]
    fn rejects_type_field_in_variant() {
        assert!(error("enum E { A { r#type: u8 } }").contains("TypeScript discriminant"));
    }

    #[test]
    fn reports_every_bad_variant() {
        let message = error("enum E { A(u8, u8), B = 2 }");
        assert!(message.contains("exactly one field"), "{message}");
        let input: DeriveInput = syn::parse_str("enum E { A(u8, u8), B = 2 }").unwrap();
        let count = expand(&input).unwrap_err().into_iter().count();
        assert_eq!(count, 2);
    }
}
