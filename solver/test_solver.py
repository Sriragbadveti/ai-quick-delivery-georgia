from app import solve

def test_prefers_urgent_order_when_one_courier():
    # one courier, two orders; deferring order 0 is expensive (near its promise), order 1 is cheap to defer
    big = 1e6
    costs = [[9.0, 15.0, big], [6.0, big, 6.7]]
    assert solve(costs, big) == [0, 2]

def test_square_assignment():
    costs = [[4, 1, 3], [2, 0, 5], [3, 2, 2]]
    a = solve(costs)
    assert sorted(a) == [0, 1, 2] and sum(costs[i][a[i]] for i in range(3)) == 5
