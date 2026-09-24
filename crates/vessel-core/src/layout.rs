//! Recursive pane tree for a session. Pure: no state, no IO, no daemon access.
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const MAX_DEPTH: usize = 8;
pub const MAX_LEAVES: usize = 32;
const MIN_SIZE: f32 = 0.05;
const MAX_SIZE: f32 = 100.0;

/// `Row` places children side by side, `Column` stacks them.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Axis {
    Row,
    Column,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Pane {
    Leaf {
        terminal_id: String,
    },
    Split {
        direction: Axis,
        children: Vec<Child>,
    },
}

/// A pane plus the share of its parent's axis that it occupies. Sizes are relative
/// weights, never normalized, so removing a sibling needs no arithmetic.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Child {
    pub size: f32,
    pub pane: Pane,
}

impl Pane {
    pub fn leaf(terminal_id: impl Into<String>) -> Self {
        Pane::Leaf {
            terminal_id: terminal_id.into(),
        }
    }
}

pub fn leaves(pane: &Pane) -> Vec<&str> {
    let mut out = Vec::new();
    collect(pane, &mut out);
    out
}

fn collect<'a>(pane: &'a Pane, out: &mut Vec<&'a str>) {
    match pane {
        Pane::Leaf { terminal_id } => out.push(terminal_id),
        Pane::Split { children, .. } => children.iter().for_each(|c| collect(&c.pane, out)),
    }
}

pub fn depth(pane: &Pane) -> usize {
    match pane {
        Pane::Leaf { .. } => 1,
        Pane::Split { children, .. } => {
            1 + children.iter().map(|c| depth(&c.pane)).max().unwrap_or(0)
        }
    }
}

/// Rejects anything a client should not be able to store. Strict: callers surface the error.
pub fn validate(root: &Pane, owned: &HashSet<&str>) -> Result<()> {
    let ids = leaves(root);
    if ids.len() > MAX_LEAVES {
        bail!("A session supports at most {MAX_LEAVES} panes");
    }
    if depth(root) > MAX_DEPTH {
        bail!("Panes are nested more than {MAX_DEPTH} levels deep");
    }
    let mut seen = HashSet::new();
    for id in &ids {
        if !owned.contains(id) {
            bail!("Layout pane is not a terminal in this session");
        }
        if !seen.insert(*id) {
            bail!("Layout shows the same terminal twice");
        }
    }
    splits(root)
}

fn splits(pane: &Pane) -> Result<()> {
    if let Pane::Split { children, .. } = pane {
        if children.len() < 2 {
            bail!("A split needs at least two panes");
        }
        for child in children {
            if !child.size.is_finite() || child.size <= 0.0 {
                bail!("Pane size must be a positive number");
            }
            splits(&child.pane)?;
        }
    }
    Ok(())
}

/// Forgiving counterpart to `validate`, for data already on disk: drops what cannot be
/// kept and fixes the rest rather than discarding the whole tree.
pub fn repair(root: Pane, owned: &HashSet<&str>) -> Option<Pane> {
    let mut seen = HashSet::new();
    node(root, owned, &mut seen, 1)
}

fn node(
    pane: Pane,
    owned: &HashSet<&str>,
    seen: &mut HashSet<String>,
    level: usize,
) -> Option<Pane> {
    match pane {
        Pane::Leaf { terminal_id } => (owned.contains(terminal_id.as_str())
            && seen.insert(terminal_id.clone()))
        .then_some(Pane::Leaf { terminal_id }),
        Pane::Split {
            direction,
            children,
        } => {
            if level >= MAX_DEPTH {
                return children
                    .into_iter()
                    .find_map(|c| node(c.pane, owned, seen, level));
            }
            let mut kept: Vec<Child> = children
                .into_iter()
                .filter_map(|c| {
                    node(c.pane, owned, seen, level + 1).map(|pane| Child {
                        size: if c.size.is_finite() && c.size > 0.0 {
                            c.size.clamp(MIN_SIZE, MAX_SIZE)
                        } else {
                            1.0
                        },
                        pane,
                    })
                })
                .collect();
            match kept.len() {
                0 => None,
                1 => Some(kept.remove(0).pane),
                _ => Some(Pane::Split {
                    direction,
                    children: kept,
                }),
            }
        }
    }
}

/// Drops every leaf `keep` rejects, collapsing a split left with one child into that child
/// so the survivor inherits the pair's box.
pub fn prune(pane: Pane, keep: &impl Fn(&str) -> bool) -> Option<Pane> {
    match pane {
        Pane::Leaf { terminal_id } => keep(&terminal_id).then_some(Pane::Leaf { terminal_id }),
        Pane::Split {
            direction,
            children,
        } => {
            let mut kept: Vec<Child> = children
                .into_iter()
                .filter_map(|c| prune(c.pane, keep).map(|pane| Child { size: c.size, pane }))
                .collect();
            match kept.len() {
                0 => None,
                1 => Some(kept.remove(0).pane),
                _ => Some(Pane::Split {
                    direction,
                    children: kept,
                }),
            }
        }
    }
}

/// Halves the target leaf to make room for `new_id`. When the enclosing split already runs
/// along `axis` the new pane joins it as a sibling instead of nesting another level.
pub fn split_leaf(pane: Pane, target: &str, new_id: &str, axis: Axis) -> Pane {
    match pane {
        Pane::Leaf { terminal_id } if terminal_id == target => Pane::Split {
            direction: axis,
            children: vec![
                Child {
                    size: 1.0,
                    pane: Pane::Leaf { terminal_id },
                },
                Child {
                    size: 1.0,
                    pane: Pane::leaf(new_id),
                },
            ],
        },
        Pane::Leaf { .. } => pane,
        Pane::Split {
            direction,
            mut children,
        } => {
            if direction == axis {
                if let Some(i) = children.iter().position(
                    |c| matches!(&c.pane, Pane::Leaf { terminal_id } if terminal_id == target),
                ) {
                    let half = children[i].size / 2.0;
                    children[i].size = half;
                    children.insert(
                        i + 1,
                        Child {
                            size: half,
                            pane: Pane::leaf(new_id),
                        },
                    );
                    return Pane::Split {
                        direction,
                        children,
                    };
                }
            }
            Pane::Split {
                direction,
                children: children
                    .into_iter()
                    .map(|c| Child {
                        size: c.size,
                        pane: split_leaf(c.pane, target, new_id, axis),
                    })
                    .collect(),
            }
        }
    }
}

/// Points the leaf showing `from` at `to`, falling back to the first leaf. Generalizes the
/// old two-slot clamp to any number of panes.
pub fn replace_leaf(root: &mut Pane, from: Option<&str>, to: &str) -> bool {
    from.is_some_and(|f| replace(root, to, &|id| id == f)) || replace(root, to, &|_| true)
}

fn replace(pane: &mut Pane, to: &str, pick: &impl Fn(&str) -> bool) -> bool {
    match pane {
        Pane::Leaf { terminal_id } => {
            if pick(terminal_id) {
                *terminal_id = to.into();
                true
            } else {
                false
            }
        }
        Pane::Split { children, .. } => children.iter_mut().any(|c| replace(&mut c.pane, to, pick)),
    }
}

/// Rebuilds a pre-tree `{direction, terminalIds}` layout. `vertical` meant side by side.
pub fn from_legacy(direction: &str, ids: &[String]) -> Option<Pane> {
    if direction == "tabs" || ids.len() < 2 {
        return ids.first().map(Pane::leaf);
    }
    Some(Pane::Split {
        direction: if direction == "vertical" {
            Axis::Row
        } else {
            Axis::Column
        },
        children: ids
            .iter()
            .map(|id| Child {
                size: 1.0,
                pane: Pane::leaf(id),
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn owned<'a>(ids: &[&'a str]) -> HashSet<&'a str> {
        ids.iter().copied().collect()
    }

    #[test]
    fn splitting_along_the_same_axis_stays_flat_and_halves_only_the_target() {
        let root = Pane::leaf("a");
        let root = split_leaf(root, "a", "b", Axis::Row);
        let root = split_leaf(root, "b", "c", Axis::Row);
        assert_eq!(leaves(&root), ["a", "b", "c"]);
        assert_eq!(depth(&root), 2);
        let Pane::Split { children, .. } = &root else {
            panic!("expected a split");
        };
        assert_eq!(children[0].size, 1.0);
        assert_eq!(children[1].size, 0.5);
        assert_eq!(children[2].size, 0.5);
    }

    #[test]
    fn splitting_across_axes_nests() {
        let root = split_leaf(Pane::leaf("a"), "a", "b", Axis::Row);
        let root = split_leaf(root, "b", "c", Axis::Column);
        assert_eq!(leaves(&root), ["a", "b", "c"]);
        assert_eq!(depth(&root), 3);
    }

    #[test]
    fn pruning_collapses_a_split_left_with_one_child() {
        let root = split_leaf(Pane::leaf("a"), "a", "b", Axis::Row);
        let root = split_leaf(root, "b", "c", Axis::Column);
        let pruned = prune(root, &|id| id != "c").unwrap();
        assert_eq!(leaves(&pruned), ["a", "b"]);
        assert_eq!(depth(&pruned), 2);
        assert!(prune(Pane::leaf("a"), &|id| id != "a").is_none());
    }

    #[test]
    fn replace_prefers_the_named_leaf_then_falls_back_to_the_first() {
        let mut root = split_leaf(Pane::leaf("a"), "a", "b", Axis::Row);
        assert!(replace_leaf(&mut root, Some("b"), "c"));
        assert_eq!(leaves(&root), ["a", "c"]);
        assert!(replace_leaf(&mut root, Some("missing"), "d"));
        assert_eq!(leaves(&root), ["d", "c"]);
    }

    #[test]
    fn validate_rejects_foreign_duplicate_and_degenerate_trees() {
        let root = split_leaf(Pane::leaf("a"), "a", "b", Axis::Row);
        assert!(validate(&root, &owned(&["a", "b"])).is_ok());
        assert!(validate(&root, &owned(&["a"])).is_err());

        let dupe = Pane::Split {
            direction: Axis::Row,
            children: vec![
                Child {
                    size: 1.0,
                    pane: Pane::leaf("a"),
                },
                Child {
                    size: 1.0,
                    pane: Pane::leaf("a"),
                },
            ],
        };
        assert!(validate(&dupe, &owned(&["a"])).is_err());

        let lonely = Pane::Split {
            direction: Axis::Row,
            children: vec![Child {
                size: 1.0,
                pane: Pane::leaf("a"),
            }],
        };
        assert!(validate(&lonely, &owned(&["a"])).is_err());

        let zero = Pane::Split {
            direction: Axis::Row,
            children: vec![
                Child {
                    size: 0.0,
                    pane: Pane::leaf("a"),
                },
                Child {
                    size: 1.0,
                    pane: Pane::leaf("b"),
                },
            ],
        };
        assert!(validate(&zero, &owned(&["a", "b"])).is_err());
    }

    #[test]
    fn repair_keeps_what_it_can_instead_of_discarding_the_tree() {
        let broken = Pane::Split {
            direction: Axis::Row,
            children: vec![
                Child {
                    size: f32::NAN,
                    pane: Pane::leaf("a"),
                },
                Child {
                    size: 1.0,
                    pane: Pane::leaf("gone"),
                },
                Child {
                    size: 1.0,
                    pane: Pane::leaf("a"),
                },
                Child {
                    size: 1.0,
                    pane: Pane::leaf("b"),
                },
            ],
        };
        let fixed = repair(broken, &owned(&["a", "b"])).unwrap();
        assert_eq!(leaves(&fixed), ["a", "b"]);
        let Pane::Split { children, .. } = &fixed else {
            panic!("expected a split");
        };
        assert_eq!(children[0].size, 1.0);
        assert!(repair(Pane::leaf("gone"), &owned(&["a"])).is_none());
    }

    #[test]
    fn legacy_layouts_become_trees_without_losing_panes() {
        assert!(from_legacy("tabs", &[]).is_none());
        let flat = from_legacy("vertical", &["a".into(), "b".into()]).unwrap();
        assert_eq!(leaves(&flat), ["a", "b"]);
        assert!(matches!(
            flat,
            Pane::Split {
                direction: Axis::Row,
                ..
            }
        ));
        let stacked = from_legacy("horizontal", &["a".into(), "b".into(), "c".into()]).unwrap();
        assert_eq!(leaves(&stacked), ["a", "b", "c"]);
        assert!(matches!(
            stacked,
            Pane::Split {
                direction: Axis::Column,
                ..
            }
        ));
    }

    #[test]
    fn a_tree_round_trips_through_json() {
        let root = split_leaf(
            split_leaf(Pane::leaf("a"), "a", "b", Axis::Row),
            "b",
            "c",
            Axis::Column,
        );
        let encoded = serde_json::to_string(&root).unwrap();
        assert!(encoded.contains("\"terminalId\""));
        assert!(encoded.contains("\"type\":\"leaf\""));
        let decoded: Pane = serde_json::from_str(&encoded).unwrap();
        assert_eq!(leaves(&decoded), leaves(&root));
    }
}
