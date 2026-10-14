"""Ranking metric implementations.

    pytest ml/tests -q

NOT executed in the authoring environment (no Python available there).
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from ml.evaluation.evaluate_ranker import (average_precision, dcg, mrr,  # noqa: E402
                                           ndcg_at_k, precision_at_k, recall_at_k)


def test_perfect_ranking_scores_one():
    assert ndcg_at_k([4, 3, 2, 1, 0], 5) == 1.0


def test_worst_ranking_scores_below_perfect():
    assert ndcg_at_k([0, 1, 2, 3, 4], 5) < ndcg_at_k([4, 3, 2, 1, 0], 5)


def test_all_zero_relevance_is_zero_not_nan():
    assert ndcg_at_k([0, 0, 0], 5) == 0.0


def test_dcg_discounts_by_position():
    assert dcg([1, 0], 2) > dcg([0, 1], 2)


def test_ndcg_respects_k():
    rels = [0, 0, 0, 0, 0, 4]
    assert ndcg_at_k(rels, 5) == 0.0
    assert ndcg_at_k(rels, 10) > 0.0


def test_mrr_uses_first_relevant_position():
    assert mrr([0, 0, 1]) == 1 / 3
    assert mrr([1, 0, 0]) == 1.0
    assert mrr([0, 0, 0]) == 0.0


def test_precision_at_k():
    assert precision_at_k([1, 0, 1, 0], 4) == 0.5
    assert precision_at_k([], 5) == 0.0


def test_recall_at_k():
    assert recall_at_k([1, 0, 0, 1], 2) == 0.5
    assert recall_at_k([0, 0], 2) == 0.0


def test_average_precision_rewards_early_hits():
    assert average_precision([1, 0, 1], 3) > average_precision([0, 1, 1], 3)


def test_graded_labels_outrank_binary_equivalents():
    """A transaction (4) at rank 1 must beat a click (1) at rank 1."""
    assert dcg([4], 1) > dcg([1], 1)
