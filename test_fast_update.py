import unittest
from datetime import datetime, timezone

from fast_update import blend_official, blend_schedule, finished_from_page, parse_sets, result_row


class ScoreTests(unittest.TestCase):
    def test_slash_colon_and_dash(self):
        self.assertEqual(parse_sets("3/1"), (3, 1))
        self.assertEqual(parse_sets("2/3"), (2, 3))
        self.assertEqual(parse_sets("0/3"), (0, 3))
        self.assertEqual(parse_sets("3:2"), (3, 2))
        self.assertEqual(parse_sets("3-0"), (3, 0))
        self.assertEqual(parse_sets(" 3 / 1 "), (3, 1))

    def test_unfinished_scores_are_ignored(self):
        self.assertIsNone(parse_sets(""))
        self.assertIsNone(parse_sets("1/2"))
        self.assertIsNone(parse_sets("2/2"))
        self.assertIsNone(parse_sets("3/3"))
        self.assertIsNone(parse_sets("walkover"))

    def test_page_row_names_the_winner(self):
        page = """
        <table><tr><td>05:00</td><td>1 vs 6</td><td>Kolodziej, Krystian</td><td>Wisniewski, Karol</td><td>2/3</td></tr>
        <tr><td>05:25</td><td>2 vs 5</td><td>Szurlej, Kacper</td><td>Kostal, Daniel</td><td>0/3</td></tr>
        <tr><td>06:10</td><td>1 vs 2</td><td>Kolodziej, Krystian</td><td>Szurlej, Kacper</td><td>1/2</td></tr>
        </table>
        """
        canon = {
            "kolodziej krystian": "Kolodziej Krystian",
            "wisniewski karol": "Wisniewski Karol",
            "szurlej kacper": "Szurlej Kacper",
            "kostal daniel": "Kostal Daniel",
        }
        day = datetime(2026, 10, 4).date()
        rows = finished_from_page(page, day, canon)
        self.assertEqual(len(rows), 3)
        self.assertIsNone(rows[2][4])
        self.assertEqual(result_row(rows[0][0], rows[0][2], rows[0][3], rows[0][4]),
                         "2026-10-04 | Wisniewski Karol | Kolodziej Krystian | 3-2 |  |  | ")
        self.assertEqual(result_row(rows[1][0], rows[1][2], rows[1][3], rows[1][4]),
                         "2026-10-04 | Kostal Daniel | Szurlej Kacper | 3-0 |  |  | ")

    def test_night_page_after_midnight_is_the_next_morning(self):
        page = """
        <table>
        <tr><td>01:30</td><td>1 vs 2</td><td>Durda, Michal</td><td>Sikon, Mateusz</td><td>3/1</td></tr>
        <tr><td>03:30</td><td>2 vs 3</td><td>Sawicki, Grzegorz</td><td>Badura, Jaroslaw</td><td>0/3</td></tr>
        </table>
        """
        canon = {
            "durda michal": "Durda Michal",
            "sikon mateusz": "Sikon Mateusz",
            "sawicki grzegorz": "Sawicki Grzegorz",
            "badura jaroslaw": "Badura Jaroslaw",
        }
        day = datetime(2026, 10, 3).date()
        rows = finished_from_page(page, day, canon, night=True)
        self.assertEqual(rows[0][0].isoformat(), "2026-10-04")
        self.assertEqual(result_row(rows[1][0], rows[1][2], rows[1][3], rows[1][4]),
                         "2026-10-04 | Badura Jaroslaw | Sawicki Grzegorz | 3-0 |  |  | ")
        morning = finished_from_page(page, day, canon, night=False)
        self.assertEqual(morning[0][0].isoformat(), "2026-10-03")


class BlendTests(unittest.TestCase):
    def test_repeat_score_same_day_is_kept(self):
        old = "\n".join([
            "# Official results collected from tt-series.com (updated automatically)",
            "# updated 2026-10-04T05:25Z",
            "# date | winner | loser | score | winner's match # that day | loser's match # that day | winner's Elo change",
            "2026-10-04 | A | B | 3-1 | 1 | 1 | +8",
        ]) + "\n"
        incoming = "\n".join([
            "# Official results collected from tt-series.com (updated automatically)",
            "2026-10-04 | A | B | 3-1 |  |  | ",
            "2026-10-04 | A | B | 3-1 |  |  | ",
        ]) + "\n"
        out = blend_official(old, incoming, now=datetime(2026, 10, 4, 9, 40, tzinfo=timezone.utc))
        rows = [line for line in out.splitlines() if line.startswith("2026-10-04")]
        self.assertEqual(len(rows), 2)
        self.assertIn("+8", rows[0])
        self.assertIn("# updated 2026-10-04T09:40Z", out)

    def test_richer_player_page_row_wins_over_a_plain_one(self):
        plain = "# Official results collected from tt-series.com (updated automatically)\n# updated 2026-10-04T09:00Z\n2026-10-04 | A | B | 3-0 |  |  | \n"
        rich = "# Official results collected from tt-series.com (updated automatically)\n# updated 2026-10-04T09:10Z\n2026-10-04 | A | B | 3-0 | 2 | 2 | +16\n"
        out = blend_official(plain, rich)
        self.assertIn("2026-10-04 | A | B | 3-0 | 2 | 2 | +16", out)
        self.assertEqual(sum(1 for line in out.splitlines() if line.startswith("2026-10-04")), 1)
        self.assertIn("# updated 2026-10-04T09:10Z", out)

    def test_schedule_keeps_a_filled_in_score(self):
        blank = "# Match schedule from tt-series.com, Polish time (updated automatically)\n# date | time | tournament | player 1 | player 2 | result\n2026-10-04 | 05:00 | Morning | A | B | \n"
        filled = "# Match schedule from tt-series.com, Polish time (updated automatically)\n# date | time | tournament | player 1 | player 2 | result\n2026-10-04 | 05:00 | Morning | A | B | 2:3\n"
        out = blend_schedule(blank, filled)
        self.assertIn("2026-10-04 | 05:00 | Morning | A | B | 2:3", out)
        self.assertEqual(sum(1 for line in out.splitlines() if line.startswith("2026-10-04")), 1)


class CadenceTests(unittest.TestCase):
    def test_collectors_run_every_30_minutes_on_separate_locks(self):
        def text(path):
            with open(path, encoding="utf-8") as fh:
                return fh.read()
        fast = text(".github/workflows/fast-update.yml")
        ratings = text(".github/workflows/update-ratings.yml")
        self.assertIn('8,38 * * * *', fast)
        self.assertIn('7,37 * * * *', ratings)
        self.assertNotIn("data-update", fast)
        self.assertNotIn("data-update", ratings)
        page = text("index.html")
        self.assertIn("every 30 minutes", page)
        self.assertNotIn("once an hour", page)
        self.assertNotIn("next hourly update", page)
        self.assertIn("tt-check-v76", text("sw.js"))


if __name__ == "__main__":
    unittest.main()
