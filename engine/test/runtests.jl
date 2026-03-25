# runtests.jl — Test runner for MileagePlusDealFinder engine

using Test

# Load source files
include(joinpath(@__DIR__, "..", "src", "types.jl"))
include(joinpath(@__DIR__, "..", "src", "bonus.jl"))
include(joinpath(@__DIR__, "..", "src", "scoring.jl"))

@testset "MileagePlusDealFinder Engine" begin
    include("test_bonus.jl")
    include("test_scoring.jl")
end
