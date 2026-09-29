package mapgen

// rng 是 xoshiro256** 伪随机流（splitmix64 播种）。纯整数运算，同 seed 必
// 产出同一序列——确定性地图生成（同 seed 同 MapHash）依赖这一点。
type rng struct {
	s [4]uint64
}

func newRng(seed uint64) *rng {
	r := &rng{}
	z := seed
	for i := range r.s {
		z += 0x9E3779B97F4A7C15
		x := z
		x = (x ^ (x >> 30)) * 0xBF58476D1CE4E5B9
		x = (x ^ (x >> 27)) * 0x94D049BB133111EB
		x ^= x >> 31
		r.s[i] = x
	}
	return r
}

func rotl(x uint64, k uint) uint64 { return x<<k | x>>(64-k) }

func (r *rng) next() uint64 {
	res := rotl(r.s[1]*5, 7) * 9
	t := r.s[1] << 17
	r.s[2] ^= r.s[0]
	r.s[3] ^= r.s[1]
	r.s[1] ^= r.s[2]
	r.s[0] ^= r.s[3]
	r.s[2] ^= t
	r.s[3] = rotl(r.s[3], 45)
	return res
}

// float 返回 [0,1) 内的均匀浮点（53 位精度：(next>>11)·2⁻⁵³）。
func (r *rng) float() float64 { return float64(r.next()>>11) * (1.0 / (1 << 53)) }

// rangeF 返回 [lo,hi) 内的均匀浮点（乘加合成，确定性）。
func (r *rng) rangeF(lo, hi float64) float64 { return lo + (hi-lo)*r.float() }

// intn 返回 [0,n) 内的整数。掩模偏差对地图布局无影响且完全确定。
func (r *rng) intn(n int) int { return int(r.next() % uint64(n)) }
