import User from "../models/User.js";
import { getConnectedUsers, getIO } from "../socket/socket.server.js";
import axios from "axios";

export const swipeRight = async (req, res) => {
	try {
		const { likedUserId } = req.params;
		const currentUser = await User.findById(req.user.id);
		const likedUser = await User.findById(likedUserId);

		if (!likedUser) {
			return res.status(404).json({
				success: false,
				message: "User not found",
			});
		}

		if (!currentUser.likes.includes(likedUserId)) {
			currentUser.likes.push(likedUserId);
			await currentUser.save();

			// if the other user already liked us, it's a match, so let's update both users
			if (likedUser.likes.includes(currentUser.id)) {
				currentUser.matches.push(likedUserId);
				likedUser.matches.push(currentUser.id);

				await Promise.all([await currentUser.save(), await likedUser.save()]);

				// send notification in real-time with socket.io
				const connectedUsers = getConnectedUsers();
				const io = getIO();

				const likedUserSocketId = connectedUsers.get(likedUserId);

				if (likedUserSocketId) {
					io.to(likedUserSocketId).emit("newMatch", {
						_id: currentUser._id,
						name: currentUser.name,
						image: currentUser.image,
					});
				}

				const currentSocketId = connectedUsers.get(currentUser._id.toString());
				if (currentSocketId) {
					io.to(currentSocketId).emit("newMatch", {
						_id: likedUser._id,
						name: likedUser.name,
						image: likedUser.image,
					});
				}
			}
		}

		res.status(200).json({
			success: true,
			user: currentUser,
		});
	} catch (error) {
		console.log("Error in swipeRight: ", error);

		res.status(500).json({
			success: false,
			message: "Internal server error",
		});
	}
};

export const swipeLeft = async (req, res) => {
	try {
		const { dislikedUserId } = req.params;
		const currentUser = await User.findById(req.user.id);

		if (!currentUser.dislikes.includes(dislikedUserId)) {
			currentUser.dislikes.push(dislikedUserId);
			await currentUser.save();
		}

		res.status(200).json({
			success: true,
			user: currentUser,
		});
	} catch (error) {
		console.log("Error in swipeLeft: ", error);

		res.status(500).json({
			success: false,
			message: "Internal server error",
		});
	}
};

export const getMatches = async (req, res) => {
	try {
		const user = await User.findById(req.user.id).populate("matches", "name image");

		res.status(200).json({
			success: true,
			matches: user.matches,
		});
	} catch (error) {
		console.log("Error in getMatches: ", error);

		res.status(500).json({
			success: false,
			message: "Internal server error",
		});
	}
};

export const getUserProfiles = async (req, res) => {
	try {
		const currentUser = await User.findById(req.user.id);

		// Get all users in the same location, excluding current user, likes, dislikes, and matches
		const users = await User.find({
			$and: [
				{ _id: { $ne: currentUser.id } },
				{ _id: { $nin: currentUser.likes } },
				{ _id: { $nin: currentUser.dislikes } },
				{ _id: { $nin: currentUser.matches } },
				{ location: currentUser.location } // Add location filter
			],
		});

		if (!users.length) {
			return res.status(200).json({
				success: true,
				users: [], // Return empty array if no users found
			});
		}

		// Calculate compatibility scores for all users
		const usersWithScores = await Promise.all(
			users.map(async (user) => {
				const score = await calculateCompatibilityScore(currentUser, user);
				return {
					...user.toObject(),
					compatibilityScore: score
				};
			})
		);

		res.status(200).json({
			success: true,
			users: usersWithScores,
		});
	} catch (error) {
		console.log("Error in getUserProfiles: ", error);
		res.status(500).json({
			success: false,
			message: "Internal server error",
		});
	}
};

// Helper function to calculate compatibility score
async function calculateCompatibilityScore(currentUser, otherUser) {
	let totalScore = 0;
	
	// 1. Ingredients Compatibility (20 points max)
	const ingredientsScore = await calculateIngredientsCompatibility(
		currentUser,
		otherUser
	);
	totalScore += ingredientsScore * 20;

	// Location Compatibility (10 points max)


	console.log("totalScore: ", totalScore);

	return Math.round(totalScore);
}

async function calculateIngredientsCompatibility(currentUser, otherUser) {
	try {
		const combinedIngredients = [
			...currentUser.ingredientsList.map(i => `${i.quantity} ${i.ingredient}`),
			...otherUser.ingredientsList.map(i => `${i.quantity} ${i.ingredient}`)
		].join(', ');

		const response = await axios.get('https://api.calorieninjas.com/v1/nutrition', {
			params: { query: combinedIngredients },
			headers: {
				'X-Api-Key': process.env.CALORIE_NINJA_API_KEY
			}
		});

		if (!response.data.items?.length) return 0;

		// Calculate total macronutrients
		const totalNutrients = response.data.items.reduce((acc, item) => ({
			protein: acc.protein + (item.protein_g || 0),
			carbs: acc.carbs + (item.carbohydrates_total_g || 0),
			fats: acc.fats + (item.fat_total_g || 0)
		}), { protein: 0, carbs: 0, fats: 0 });

		// Compare with dietary goals
		const dietaryGoals = currentUser.dietaryGoals;
	
		// Calculate how close we are to meeting each goal
		const goalCompletion = {
			protein: dietaryGoals.protein === 0 ? 1 : Math.min(totalNutrients.protein / dietaryGoals.protein, 1.0),
			carbs: dietaryGoals.carbs === 0 ? 1 : Math.min(totalNutrients.carbs / dietaryGoals.carbs, 1.0),
			fats: dietaryGoals.fats === 0 ? 1 : Math.min(totalNutrients.fats / dietaryGoals.fats, 1.0)
		};

		// Calculate average completion ratio
		const avgCompletion = (goalCompletion.protein + goalCompletion.carbs + goalCompletion.fats) / 3;

		console.log({
			totalNutrients,
			dietaryGoals,
			goalCompletion,
			score: avgCompletion
		});

		return avgCompletion;
		
	} catch (error) {
		console.error('Error calculating ingredients compatibility:', error);
		return 0;
	}
}
